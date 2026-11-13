import * as vscode from 'vscode'
import type { BehaviorSource, BehaviorEventType, WsServerMessage, UserState } from '@anchor/types'
import { DEFAULT_DATA_KEY, STATE_LABELS, STATE_COLOR_TOKENS } from '@anchor/utils'
import { lightColors } from '@anchor/ui/tokens'
import { connect, disconnect, isConnected, send, onMessage, onReconnect, setConfigError } from './ws-client'
import { createOfflineQueue } from './offline-queue'
import { inferTerminalCategory } from './terminal'

let activityCount = 0
const REPORT_INTERVAL_MS = 60_000 // 每 60 秒上报一次

// editor_idle 检测：记录最后按键时间
let _lastKeyAt = Date.now()
// editor_idle 已上报标志，避免重复上报直到用户重新活跃
let _idleReported = false
const IDLE_THRESHOLD_MS = 10 * 60 * 1000 // 10 分钟无按键视为编辑器空闲
const IDLE_THRESHOLD_SEC = IDLE_THRESHOLD_MS / 1000

const SOURCE: BehaviorSource = 'vscode'

// 状态栏项，用于显示 sunset 阶段
let _statusBarItem: vscode.StatusBarItem | null = null

// 最近一次服务器推断的用户状态（state:update 写入），驱动 StatusBar 状态色
let _userState: UserState | null = null
let _configError: string | null = null
let _sunsetTooltip = 'Anchor 节律守护中'

// 状态 → StatusBar 颜色（token 映射单一来源 packages/utils/src/state.ts，
// 色值真源 @anchor/ui tokens；VS Code 状态栏多为主题深底，统一用浅色色值）
function updateStatusBarState(): void {
  if (!_statusBarItem) return
  
  // 配置错误状态
  if (_configError) {
    _statusBarItem.text = '$(warning) Anchor 配置错误'
    _statusBarItem.tooltip = _configError
    _statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningBackground')
    return
  }
  
  const token = _userState ? STATE_COLOR_TOKENS[_userState] : null
  _statusBarItem.color = token ? lightColors[token] : undefined
  const stateLabel = _userState ? ` · ${STATE_LABELS[_userState]}` : ''
  _statusBarItem.tooltip = _sunsetTooltip + stateLabel
}

export function activate(context: vscode.ExtensionContext) {
  // 读取 VS Code 设置中的服务器地址与数据密钥（含默认值）
  const cfg = vscode.workspace.getConfiguration('anchor')
  const serverUrl = cfg.get<string>('serverUrl')?.trim() || 'http://localhost:4000'
  const dataKey = cfg.get<string>('dataKey')?.trim() || DEFAULT_DATA_KEY
  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws'

  // 创建状态栏项
  _statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  _statusBarItem.text = '$(anchor) Anchor'
  _statusBarItem.tooltip = 'Anchor 节律守护中'
  _statusBarItem.show()
  context.subscriptions.push(_statusBarItem)

  // 连接 Anchor 服务器（WS 直发；断线入队，重连后批量补发）
  _queue = createOfflineQueue(context, serverUrl, dataKey)
  onReconnect(() => {
    void _queue?.flush()
  })
  connect(wsUrl, dataKey)

  // 设置变更：重建离线队列并按新地址/密钥重连（connect 内部清理旧连接与重连计时器）
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('anchor.serverUrl') && !e.affectsConfiguration('anchor.dataKey')) return
      const nextCfg = vscode.workspace.getConfiguration('anchor')
      const nextUrl = nextCfg.get<string>('serverUrl')?.trim() || 'http://localhost:4000'
      const nextKey = nextCfg.get<string>('dataKey')?.trim() || DEFAULT_DATA_KEY
      _queue = createOfflineQueue(context, nextUrl, nextKey)
      connect(nextUrl.replace(/^http/, 'ws') + '/ws', nextKey)
    }),
  )

  // 监听服务器推送，处理各类消息
  onMessage((msg) => {
    handleServerMessage(msg)
  })

  // 监听文本变化（按键活动）
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(() => {
      activityCount++
      _lastKeyAt = Date.now()
      _idleReported = false // 用户重新活跃，重置空闲上报标志
    })
  )

  // 监听文件保存：扩展 payload，增加 files_open_count、workspace_name、language
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      report('code_active', {
        event: 'file_save',
        language: doc.languageId,
        workspace_name: getWorkspaceName(),
        files_open_count: getOpenFilesCount(),
      })
    })
  )

  // 定时上报活动摘要（含扩展字段）
  const timer = setInterval(() => {
    if (activityCount > 0) {
      report('code_active', {
        event: 'keystroke_summary',
        count: activityCount,
        workspace_name: getWorkspaceName(),
        files_open_count: getOpenFilesCount(),
        active_language: getActiveLanguage(),
      })
      activityCount = 0
    }

    // 检测编辑器空闲（文件打开但 10 分钟无按键）
    const hasOpenFile = vscode.window.activeTextEditor !== undefined
    const idleSec = Math.floor((Date.now() - _lastKeyAt) / 1000)
    if (hasOpenFile && idleSec >= IDLE_THRESHOLD_SEC && !_idleReported) {
      report('editor_idle', {
        idle_seconds: idleSec,
        workspace_name: getWorkspaceName(),
        language: getActiveLanguage(),
      })
      _idleReported = true // 标记已上报，防止每分钟重复
    }
  }, REPORT_INTERVAL_MS)

  context.subscriptions.push({ dispose: () => clearInterval(timer) })

  // 监听终端开启：上报 terminal_active
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal((terminal) => {
      // 无法从 API 直接获取命令内容，分类标为 'other'
      report('terminal_active', {
        terminal_name: terminal.name,
        command_category: inferTerminalCategory(terminal.name),
      })
    })
  )

  // git_commit：通过 vscode.git 扩展 API 监听，若扩展不可用则静默跳过
  tryWatchGitCommits(context)

  // Hello World 命令
  context.subscriptions.push(
    vscode.commands.registerCommand('anchor.helloWorld', () => {
      vscode.window.showInformationMessage('Anchor 正在运行，节律守护中。')
    })
  )

  // 扩展停用时断开 WebSocket
  context.subscriptions.push({ dispose: () => disconnect() })
}

export function deactivate() {
  disconnect()
}

// ---- 服务器消息处理 --------------------------------------------------------

function updateSunsetStatusBar(phase: 'T60' | 'T30' | 'T15' | 'T0' | 'off'): void {
  if (!_statusBarItem) return
  if (phase === 'T60') {
    _statusBarItem.text = '$(anchor) T-60'
    _sunsetTooltip = '距宵禁 60 分钟'
  } else if (phase === 'T30') {
    _statusBarItem.text = '$(anchor) T-30'
    _sunsetTooltip = '距宵禁 30 分钟'
  } else if (phase === 'T15') {
    _statusBarItem.text = '$(anchor) T-15'
    _sunsetTooltip = '距宵禁 15 分钟'
  } else if (phase === 'T0') {
    _statusBarItem.text = '$(anchor) T-0'
    _sunsetTooltip = '宵禁已生效'
  } else {
    _statusBarItem.text = '$(anchor) Anchor'
    _sunsetTooltip = 'Anchor 节律守护中'
  }
  updateStatusBarState()
}

function handleServerMessage(msg: WsServerMessage): void {
  switch (msg.type) {
    case 'notify:ai': {
      vscode.window.showInformationMessage(msg.message)
      break
    }

    case 'time:anchor': {
      vscode.window.showInformationMessage(msg.text, { modal: false })
      break
    }

    case 'intervention': {
      const level = msg.level
      if (level === 'soft' || level === 'notify') {
        vscode.window.showWarningMessage(msg.message)
      } else if (level === 'hard' || level === 'strong') {
        vscode.window.showErrorMessage(msg.message)
      }
      break
    }

    case 'sunset:phase': {
      updateSunsetStatusBar(msg.phase)
      break
    }

    case 'sunset:stage': {
      // 握手快照与配置变更后的重算阶段只发 sunset:stage，必须一并处理
      updateSunsetStatusBar(msg.stage)
      break
    }

    case 'state:update': {
      _userState = msg.state
      updateStatusBarState()
      break
    }

    case 'sleep:confirm-request': {
      // 入睡确认：仅「还没睡」选项；无响应由服务器超时自动确认睡着。
      // VS Code 通知无法程序化关闭，sleep:confirm-cancel 无需处理——
      // 迟到的响应会被服务器 phase 守卫丢弃（respondSleepConfirm 非 confirming 直接返回）。
      void vscode.window
        .showInformationMessage(
          'Anchor 检测到你很久没活动，睡着了吗？无回应将视为已睡着。',
          '还没睡'
        )
        .then((choice) => {
          if (choice === '还没睡') {
            send({ type: 'sleep:confirm-response', confirmed: false })
          }
        })
      break
    }

    case 'context_switch:prompt': {
      showContextSwitchInput(msg.prompt_id, msg.timeoutSeconds, msg.placeholder)
      break
    }

    case 'context_switch:dismiss':
    case 'context_switch:typing': {
      // 其他端已响应/服务器兜底到期/其他端接管输入：程序化关闭本端弹窗
      // （onDidHide 内按标志位跳过上报）；用户已输入则保留，等待手动 Enter/Esc，提交/跳过永远有效
      if (_contextSwitch && _contextSwitch.promptId === msg.prompt_id) {
        if (_contextSwitch.inputSent) break
        _contextSwitch.programmaticHide = true
        _contextSwitch.quickPick.hide()
      }
      break
    }

    case 'error': {
      if (msg.code === 'DECRYPT_FAILED') {
        vscode.window.showErrorMessage(`Anchor: ${msg.message}`)
        _configError = msg.message
        setConfigError(msg.message)
        updateStatusBar()
      }
      break
    }

    default:
      // 其他消息类型静默记录日志
      console.log('[Anchor]', msg.type)
      break
  }
}

// ---- 状态切换弹窗（注意力残留） --------------------------------------------

interface ContextSwitchHandle {
  promptId: string
  quickPick: vscode.QuickPick<vscode.QuickPickItem>
  /** 程序化关闭（dismiss/自动跳过）时置 true，onDidHide 不再上报 skip */
  programmaticHide: boolean
  /** 用户已开始输入（接管）：dismiss/typing 广播不再关闭本端，等待手动 Enter/Esc */
  inputSent: boolean
}

let _contextSwitch: ContextSwitchHandle | null = null

function showContextSwitchInput(promptId: string, timeoutSeconds: number, placeholder: string): void {
  // 新 prompt 取代旧的
  if (_contextSwitch) {
    _contextSwitch.programmaticHide = true
    _contextSwitch.quickPick.hide()
  }

  const qp = vscode.window.createQuickPick()
  qp.title = `状态切换（${timeoutSeconds}s 内未输入自动跳过，输入后取消倒计时）`
  qp.placeholder = placeholder
  qp.items = []

  const handle: ContextSwitchHandle = { promptId, quickPick: qp, programmaticHide: false, inputSent: false }
  _contextSwitch = handle

  const respond = (action: 'submit' | 'skip' | 'auto_skip', text?: string) => {
    handle.programmaticHide = true
    send({ type: 'context_switch:response', prompt_id: promptId, action, text, source: 'vscode' })
    qp.hide()
  }

  // 倒计时：仅未输入时生效；一旦输入即取消，之后只能手动 Enter/Esc
  let autoSkipTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    respond('auto_skip')
  }, timeoutSeconds * 1000)

  qp.onDidChangeValue(() => {
    if (autoSkipTimer) {
      clearTimeout(autoSkipTimer)
      autoSkipTimer = null
      qp.title = '状态切换'
    }
    // 首次输入：上报接管信号（仅一次），服务器广播 typing 关闭其他端
    if (!handle.inputSent && qp.value) {
      handle.inputSent = true
      send({ type: 'context_switch:input', prompt_id: promptId, source: 'vscode' })
    }
  })
  qp.onDidAccept(() => {
    const value = qp.value.trim()
    if (value) {
      respond('submit', value)
    } else {
      respond('skip')
    }
  })
  qp.onDidHide(() => {
    if (autoSkipTimer) clearTimeout(autoSkipTimer)
    if (_contextSwitch === handle) _contextSwitch = null
    // 用户 Esc 关闭视为跳过
    if (!handle.programmaticHide) {
      send({ type: 'context_switch:response', prompt_id: promptId, action: 'skip', source: 'vscode' })
    }
    qp.dispose()
  })
  qp.show()
}

// ---- 行为上报 ------------------------------------------------------------

function report(event_type: BehaviorEventType, payload: Record<string, unknown>) {
  const logged_at = Math.floor(Date.now() / 1000)
  if (isConnected()) {
    send({ type: 'ingest', source: SOURCE, event_type, payload, logged_at })
    return
  }
  // WS 未连接：入队，重连后批量补发
  void _queue?.enqueue({ source: SOURCE, event_type, payload, logged_at })
}

function getWorkspaceName(): string {
  const folders = vscode.workspace.workspaceFolders
  if (!folders?.length) return 'unknown'
  return folders[0].name
}

function getActiveLanguage(): string {
  return vscode.window.activeTextEditor?.document.languageId ?? 'unknown'
}

// 获取当前打开的文档数量（近似：通过 tabGroups API，VS Code 1.90+）
function getOpenFilesCount(): number {
  try {
    let count = 0
    for (const group of vscode.window.tabGroups.all) {
      count += group.tabs.length
    }
    return count
  } catch {
    return 0
  }
}

// vscode.git 扩展导出的 API 形状（仅包含我们需要的部分）
interface GitRepository {
  state: {
    HEAD?: { commit?: string }
    onDidChange: (cb: () => void) => { dispose: () => void }
  }
}
interface GitExtensionApi {
  repositories: GitRepository[]
}

// 尝试通过 vscode.git 扩展监听 git commit，不可用时静默跳过
function tryWatchGitCommits(context: vscode.ExtensionContext) {
  const gitExt = vscode.extensions.getExtension('vscode.git')
  if (!gitExt) return

  const attachListener = (api: GitExtensionApi) => {
    for (const repo of api.repositories) {
      let _lastCommit = repo.state.HEAD?.commit
      const disposable = repo.state.onDidChange(() => {
        const current = repo.state.HEAD?.commit
        if (current && current !== _lastCommit) {
          _lastCommit = current
          report('git_commit', {
            workspace_name: getWorkspaceName(),
            commit_hash_prefix: current.slice(0, 8),
          })
        }
      })
      context.subscriptions.push(disposable)
    }
  }

  if (gitExt.isActive) {
    attachListener(gitExt.exports as GitExtensionApi)
  } else {
    Promise.resolve(gitExt.activate()).then((api) => {
      attachListener(api as GitExtensionApi)
    }).catch(() => {}) // 激活失败静默跳过
  }
}
