// 内容分类共享逻辑：sites / android apps / windows processes 三套 classify 路由复用
// 返回 { high_stimulus, is_work }，两者互斥（high_stimulus=true 时 is_work 强制 false）

export type ClassifiableKind = 'site' | 'android_app' | 'windows_process'

export interface ContentClassification {
  high_stimulus: boolean
  is_work: boolean
  source: 'ai' | 'fallback'
  raw: string
}

const PROMPTS: Record<ClassifiableKind, string> = {
  site: '你是网站分类器。根据域名、站点名称判断网站类别，返回两个维度：high_stimulus=是否属于短视频、直播、游戏、社交信息流、新闻信息流、段子娱乐等高刺激网站；is_work=是否属于开发工具、技术文档、技术社区、办公协作、生产力工具等工作向网站。两者互斥，都不属于则均为 false。只返回 JSON：{"high_stimulus":true或false,"is_work":true或false}。不确定是否高刺激时 high_stimulus 返回 true，不确定是否工作时 is_work 返回 false。',
  android_app: '你是应用分类器。根据 Android 包名、应用名、分类、版本判断应用类别，返回两个维度：high_stimulus=是否属于短视频、直播、游戏、社交信息流、新闻信息流等高刺激应用；is_work=是否属于办公、生产力、开发工具等工作向应用。两者互斥，都不属于则均为 false。只返回 JSON：{"high_stimulus":true或false,"is_work":true或false}。不确定是否高刺激时 high_stimulus 返回 true，不确定是否工作时 is_work 返回 false。',
  windows_process: '你是 Windows 桌面程序分类器。根据进程名判断程序类别，返回两个维度：high_stimulus=是否属于游戏、视频/直播客户端、社媒/娱乐客户端等高刺激程序；is_work=是否属于开发工具、终端、办公套件、笔记、生产力工具等工作向程序。系统进程与无法识别的进程两者均为 false。只返回 JSON：{"high_stimulus":true或false,"is_work":true或false}。',
}

export async function classifyContent(
  kind: ClassifiableKind,
  fields: Record<string, string>
): Promise<ContentClassification> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    return { high_stimulus: false, is_work: false, source: 'fallback', raw: '' }
  }
  try {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0,
        max_tokens: 80,
        messages: [
          { role: 'system', content: PROMPTS[kind] },
          { role: 'user', content: JSON.stringify(fields) },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    })
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content ?? ''
    // 高刺激保持既有解析语义：无法解析时默认 true（宁拦勿放）
    const highStimulus = /"high_stimulus"\s*:\s*true/i.test(content) || !/"high_stimulus"\s*:\s*false/i.test(content)
    const isWork = !highStimulus && /"is_work"\s*:\s*true/i.test(content)
    return { high_stimulus: highStimulus, is_work: isWork, source: 'ai', raw: content }
  } catch {
    // 网站/Android 出错时宁拦勿放（沿用既有语义）；Windows 进程相反——误标高刺激会导致宵禁误拦正常程序
    return { high_stimulus: kind !== 'windows_process', is_work: false, source: 'fallback', raw: '' }
  }
}
