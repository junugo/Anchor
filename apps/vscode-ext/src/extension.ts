import * as os from 'os'
import * as vscode from 'vscode'
import type { BehaviorSource, BehaviorEventType, WsServerMessage, UserState } from '@anchor/types'
import { STATE_LABELS, STATE_COLOR_TOKENS } from '@anchor/utils'
import { lightColors } from '@anchor/ui/tokens'
import { connect, disconnect, isConnected, send, onMessage, onReconnect, onAuthInvalid, onAuthOk, setConfigError, resetAuthInvalid, isAuthInvalid } from './ws-client'
import { createOfflineQueue } from './offline-queue'
import { createSecretsApi, shouldConnect, type SecretsApi } from './secrets'
import { requestPairing } from './pair'
import { inferTerminalCategory } from './terminal'
import {
  CHECK_INTERVAL_MS,
  LAST_NOTIFIED_KEY,
  RELEASES_PAGE,
  alreadyNotifiedToday,
  fetchLatestVersion,
  isNewerVersion,
  todayString,
} from './update-check'

let activityCount = 0
const REPORT_INTERVAL_MS = 60_000 // 每 60 秒上报一次

// editor_idle 检测：记录最后按键时间
let _lastKeyAt = Date.now()
// editor_idle 已上报标志，避免重复上报直到用户重新活跃
let _idleReported = false
const IDLE_THRESHOLD_MS = 10 * 60 * 1000 // 10 分钟无按键视为编辑器空闲
const IDLE_THRESHOLD_SEC = IDLE_THRESHOLD_MS / 1000

const SOURCE: BehaviorSource = 'vscode'

// 状态栏项，用于显示 sunset 阶段与配对状态
let _statusBarItem: vscode.StatusBarItem | null = null

// 配对状态：unpaired=未配对（引导） / paired=正常 / invalid=配对失效（需重新配对）
type PairingState = 'unpaired' | 'paired' | 'invalid'
let _pairingState: PairingState = 'unpaired'
let _deviceName = ''
let _serverVersion = ''
let _secrets: SecretsApi | null = null
let _extensionContext: vscode.ExtensionContext | null = null
let _queue: ReturnType<typeof createOfflineQueue> | null = null
// 最近一次发起连接所用的 token：用于「失效闩未解除且 token 未换」时跳过 connect
let _lastConnectToken: string | null = null

// 最近一次服务器推断的用户状态（state:update 写入），驱动 StatusBar 状态色
let _userState: UserState | null = null
let _configError: string | null = null
let _sunsetTooltip = 'Anchor 节律守护中'

// 状态 → StatusBar 颜色（token 映射单一来源 packages/utils/src/state.ts，
// 色值真源 @anchor/ui tokens；VS Code 状态栏多为主题深底，统一用浅色色值）
function updateStatusBarState(): void {
  if (!_statusBarItem) return

  // 未配对：引导点击登录，不参与节律着色
  if (_pairingState === 'unpaired') {
    _statusBarItem.text = '$(plug) Anchor 未配对'
    _statusBarItem.tooltip = '点击配对 Anchor（服务器地址 + 配对码）'
    _statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningBackground')
    _statusBarItem.command = 'anchor.signin'
    return
  }

  // 配对失效：引导重新配对
  if (_pairingState === 'invalid') {
    _statusBarItem.text = '$(warning) Anchor 配对失效'
    _statusBarItem.tooltip = '设备凭证已被服务器拒绝，点击重新配对'
    _statusBarItem.color = new vscode.ThemeColor('statusBarItem.errorBackground')
    _statusBarItem.command = 'anchor.repair'
    return
  }

  _statusBarItem.command = undefined

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
  const deviceInfo = _deviceName ? ` · ${_deviceName}` : ''
  const versionInfo = _serverVersion ? ` · 服务器版本 ${_serverVersion}` : ''
  _statusBarItem.tooltip = _sunsetTooltip + stateLabel + deviceInfo + versionInfo
}

/** 用 secrets 中最新凭据建立连接（无 token 时停连并走未配对引导） */
async function reconnectWithSecrets(): Promise<void> {
  if (!_secrets) return
  const cfg = vscode.workspace.getConfiguration('anchor')
  const serverUrl = cfg.get<string>('serverUrl')?.trim() || 'http://localhost:4000'
  // 钥匙串故障时不能挂起激活/配置变更流程：读失败按未配对处理
  let token: string | null = null
  let dataKey: string | null = null
  try {
    ;[token, dataKey] = await Promise.all([_secrets.getToken(), _secrets.getDataKey()])
  } catch (err) {
    console.warn('[Anchor] 读取配对凭据失败（钥匙串故障），按未配对处理：', err)
  }

  if (!shouldConnect(token)) {
    // 未配对：不启动 WS、不上报，仅状态栏引导
    disconnect()
    _queue = null
    _lastConnectToken = null
    _pairingState = 'unpaired'
    updateStatusBarState()
    console.log('[Anchor] 未配对：跳过 WS 连接与行为上报')
    return
  }

  // 失效闩未解除且 token 未换：跳过 connect，防配置变更反复弹「配对已失效」
  // （repair 会先 resetAuthInvalid，不受此检查影响）
  if (isAuthInvalid() && token === _lastConnectToken) {
    _pairingState = 'invalid'
    updateStatusBarState()
    console.log('[Anchor] 认证失效闩未解除且 token 未变，跳过重连')
    return
  }

  _pairingState = 'paired'
  _lastConnectToken = token
  _queue = createOfflineQueue(_extensionContext!, serverUrl, dataKey)
  connect(serverUrl.replace(/^http/, 'ws') + '/ws', { dataKey, token })
  updateStatusBarState()
}

/** 配对流程：signin 与 repair 共用（repair 为覆盖旧凭据的重新配对语义） */
async function runPairingFlow(): Promise<void> {
  if (!_secrets) return
  const cfg = vscode.workspace.getConfiguration('anchor')
  const defaultUrl = cfg.get<string>('serverUrl')?.trim() || 'http://localhost:4000'

  const serverUrl = await vscode.window.showInputBox({
    title: 'Anchor 配对（1/3）：服务器地址',
    value: defaultUrl,
    placeHolder: 'http://localhost:4000',
    ignoreFocusOut: true,
  })
  if (serverUrl === undefined) return

  const code = await vscode.window.showInputBox({
    title: 'Anchor 配对（2/3）：配对码',
    placeHolder: '在 dashboard 设置页生成配对码',
    ignoreFocusOut: true,
  })
  if (code === undefined) return

  const defaultName = _deviceName || os.hostname() || 'VS Code'
  const deviceName = await vscode.window.showInputBox({
    title: 'Anchor 配对（3/3）：设备名',
    value: defaultName,
    ignoreFocusOut: true,
  })
  if (deviceName === undefined) return

  const clientVersion = (_extensionContext?.extension.packageJSON as { version?: string })?.version ?? '0.0.0'
  const result = await requestPairing(serverUrl, code, deviceName.trim() || defaultName, clientVersion)
  if (!result.ok) {
    vscode.window.showErrorMessage(`Anchor 配对失败：${result.error}`)
    return
  }

  // 成功：写 secrets + 更新 serverUrl 设置（工作区级）+ 复位失效闩 + 重连
  try {
    await _secrets.setPaired({
      token: result.token,
      dataKey: result.dataKey,
      deviceName: deviceName.trim() || defaultName,
      pairedAt: Date.now(),
    })
  } catch (err) {
    console.warn('[Anchor] 配对凭据写入失败（钥匙串故障）：', err)
    vscode.window.showErrorMessage('Anchor 配对凭据保存失败，请重试配对')
    return
  }
  _deviceName = deviceName.trim() || defaultName
  _serverVersion = result.serverVersion
  const base = serverUrl.trim().replace(/\/+$/, '') || 'http://localhost:4000'
  try {
    await vscode.workspace.getConfiguration('anchor').update('serverUrl', base, vscode.ConfigurationTarget.Workspace)
  } catch (err) {
    console.warn('[Anchor] 服务器地址写入设置失败：', err)
    vscode.window.showErrorMessage('Anchor 服务器地址保存失败，请在设置中手动配置 anchor.serverUrl')
    return
  }
  vscode.window.showInformationMessage(`Anchor 配对成功：${_deviceName}`)

  resetAuthInvalid()
  await reconnectWithSecrets()
}

// ---- 更新提示（仅提示，不自动更新；失败静默） --------------------------------

/** 检查一次：有新版本且今天未提示过 → showInformationMessage；节流写入 globalState */
async function checkExtensionUpdate(context: vscode.ExtensionContext): Promise<void> {
  try {
    const current = (context.extension.packageJSON as { version?: string })?.version ?? '0.0.0'
    const latest = await fetchLatestVersion()
    if (!latest || !isNewerVersion(latest, current)) return
    const today = todayString()
    if (alreadyNotifiedToday(today, context.globalState.get(LAST_NOTIFIED_KEY))) return
    await context.globalState.update(LAST_NOTIFIED_KEY, today)
    const clean = latest.replace(/^(desktop|mobile|chrome|vscode)-v?/i, 'v')
    void vscode.window
      .showInformationMessage(`Anchor 扩展发现新版本 ${clean}`, '查看发布页')
      .then((choice) => {
        if (choice === '查看发布页') {
          void vscode.env.openExternal(vscode.Uri.parse(RELEASES_PAGE))
        }
      })
  } catch {
    // 失败静默
  }
}

export async function activate(context: vscode.ExtensionContext) {
  _extensionContext = context
  _secrets = createSecretsApi(context.secrets)
  // 设备名：优先 secrets 中上次配对名，钥匙串故障时回退 hostname，activate 绝不能挂
  let savedDeviceName: string | null = null
  try {
    savedDeviceName = await _secrets.getDeviceName()
  } catch (err) {
    console.warn('[Anchor] 读取设备名失败（钥匙串故障），回退 hostname：', err)
  }
  _deviceName = savedDeviceName || os.hostname() || 'VS Code'

  // 创建状态栏项
  _statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  _statusBarItem.text = '$(anchor) Anchor'
  _statusBarItem.tooltip = 'Anchor 节律守护中'
  _statusBarItem.show()
  context.subscriptions.push(_statusBarItem)

  // 连接 Anchor 服务器（WS 直发；断线入队，重连后批量补发）
  onReconnect(() => {
    void _queue?.flush()
  })
  await reconnectWithSecrets()

  // 配对命令：signin（未配对引导）与 repair（重新配对，覆盖旧凭据）
  context.subscriptions.push(
    vscode.commands.registerCommand('anchor.signin', () => runPairingFlow()),
    vscode.commands.registerCommand('anchor.repair', () => runPairingFlow()),
  )

  // 认证失效：状态栏置「配对失效」，引导重新配对（ws-client 已停重连风暴）
  onAuthInvalid(() => {
    _pairingState = 'invalid'
    _userState = null
    updateStatusBarState()
    void vscode.window
      .showWarningMessage('Anchor 配对已失效', '重新配对')
      .then((choice) => {
        if (choice === '重新配对') {
          void vscode.commands.executeCommand('anchor.repair')
        }
      })
  })

  // 认证成功（重新配对后首连）：清除失效态
  onAuthOk(() => {
    if (_pairingState === 'invalid') {
      _pairingState = 'paired'
      updateStatusBarState()
    }
  })

  // 服务器地址变更：按 secrets 中凭据重连（密钥已迁 SecretStorage，不再监听 dataKey 设置）
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('anchor.serverUrl')) return
      void reconnectWithSecrets()
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

  // 更新提示：激活时一次 + 每 6h（setInterval 在 deactivate 后失效，重启时补上）
  void checkExtensionUpdate(context)
  const updateTimer = setInterval(() => { void checkExtensionUpdate(context) }, CHECK_INTERVAL_MS)
  context.subscriptions.push({ dispose: () => clearInterval(updateTimer) })
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
        updateStatusBarState()
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
      send({ type: 'context_switch:input', prompt_id: promptId })
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
