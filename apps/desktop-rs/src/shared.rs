//! daemon 与 GUI 共享的状态（daemon 写，GUI 只读渲染）

/// 宵禁阶段
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum SunsetPhase {
    #[default]
    Off,
    T60,
    T30,
    T15,
    T0,
}

impl SunsetPhase {
    /// 解析服务器阶段字符串
    pub fn parse(s: &str) -> Self {
        match s {
            "T60" => Self::T60,
            "T30" => Self::T30,
            "T15" => Self::T15,
            "T0" => Self::T0,
            _ => Self::Off,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::T60 => "T60",
            Self::T30 => "T30",
            Self::T15 => "T15",
            Self::T0 => "T0",
        }
    }
}

#[derive(Clone, Debug)]
pub struct PendingNotification {
    pub title: String,
    pub body: String,
    pub silent: bool,
}

/// 通用计时提示弹窗状态（状态切换 / 睡前意图共用）：服务器广播 prompt 时填入，dismiss/响应/到期后清空
/// text 语义由各弹窗自定：状态切换 = 输入占位提示；睡前意图 = 正文 prompt
/// prompt_id 为空串表示本地重开（服务器活跃捕获已结束），超时/稍后仅本地关闭
#[derive(Clone, Debug)]
pub struct PromptDialogState {
    pub prompt_id: String,
    pub text: String,
    /// 自动超时截止时刻（Unix 秒）
    pub deadline: i64,
}

#[derive(Default)]
pub struct SharedState {
    pub connected: bool,
    /// 配置错误信息（如密钥不匹配）；Some = 错误状态，显示配置错误提示
    pub config_error: Option<String>,
    /// 服务器推断的用户状态（working/entertaining/...）
    pub user_state: Option<String>,
    pub sunset_phase: SunsetPhase,
    /// 宵禁阶段到期时刻（Unix 秒）；0 = 无。服务器离线时到期由 1s 同步循环本地解除
    pub sunset_expires_at: i64,
    /// 目标就寝时间（分钟数，默认 23:00）
    pub target_bedtime_minutes: i64,
    /// 离线队列积压数
    pub queued_offline: usize,
    pub last_ai_message: Option<String>,
    /// 待消费的系统通知（notify 模块逐个取出）
    pub pending_notifications: Vec<PendingNotification>,
    /// 入睡确认窗口截止时刻（Unix 秒）；None = 无确认请求
    pub sleep_confirm_until: Option<i64>,
    /// 状态切换弹窗；None = 无活跃弹窗
    pub context_switch: Option<PromptDialogState>,
    /// 本端已上报开始输入（接管弹窗）：收到 typing 广播时用于识别自身广播，不清空弹窗状态
    pub context_switch_input_sent: bool,
    /// 睡前意图弹窗；None = 弹窗关闭（重开入口可能仍保留）
    pub intent_capture: Option<PromptDialogState>,
    /// 本端已上报开始输入（接管弹窗）：收到 typing 广播时用于识别自身广播，不清空弹窗状态
    pub intent_input_sent: bool,
    /// 睡前意图重开入口：Some(prompt) 时托盘菜单显示「记录睡前意图」
    /// capture 时填入，dismiss answered 时清空，skipped/expired 保留
    pub intent_reopen: Option<String>,
    /// 托盘「写睡前意图」点击后由 fetch 线程写入今日意图内容（空串 = 无已写内容），
    /// sync loop 检测到后打开弹窗并预填，随即清空
    pub intent_today_prefill: Option<String>,
}

impl SharedState {
    pub fn new() -> Self {
        Self {
            target_bedtime_minutes: 1380, // 23:00
            ..Default::default()
        }
    }
}
