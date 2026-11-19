//! 窗口管理器：持有 4 个 Slint 窗口组件，托盘命令入口 + 1s 同步循环
//!
//! 同步模型：daemon 写 SharedState，本模块 Timer 每 1s 轮询同步到
//! 组件属性 / 托盘图标 / 气泡通知 / 宵禁阶段切换（pill、curfew 开关）。

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use tokio::sync::mpsc;

use crate::config::{self, Config, PillPosition};
use crate::daemon::GuiCmd;
use crate::shared::{SharedState, SunsetPhase};
use crate::tray::{self, Tray};
use crate::ui::{self, winpatch};

slint::include_modules!();

pub struct WindowManager {
    shared: Arc<RwLock<SharedState>>,
    tray: RefCell<Option<Tray>>,
    settings: SettingsWindow,
    pill: PillWindow,
    preview: PillPreviewWindow,
    curfew: CurfewWindow,
    sleep_confirm: SleepConfirmWindow,
    context_switch: PromptDialog,
    intent_capture: PromptDialog,
    toast: Toast,
    timer: slint::Timer,
    last_phase: Cell<SunsetPhase>,
    /// 宵禁提醒定时器：(阶段, 上次触发时间)
    notifier: RefCell<Option<(SunsetPhase, Instant)>>,
    notifications_enabled: bool,
    pill_position: Rc<Cell<PillPosition>>,
    /// 上次设置的 pill 坐标，避免每秒重复 set_position
    last_pill_pos: Cell<Option<(i32, i32)>>,
    /// 上次设置的 pill 文本，避免每秒重复 set_text
    last_pill_text: RefCell<String>,
    /// 上次设置的托盘 tooltip，避免每秒重复 Shell_NotifyIconW
    last_tooltip: RefCell<String>,
    /// 宵禁窗口上次刷新重绘/置顶的时间，避免锁屏/切后台后内容丢失
    last_curfew_refresh: Cell<Option<Instant>>,
    /// 上次 pair_invalid 状态：上升沿时打开设置窗引导重新配对
    last_pair_invalid: Cell<bool>,
    /// winddown 倒数归零后的本地升级截止时刻：服务器 T0 广播最晚 1 个轻量 tick
    /// （60s）到达，超过宽限仍未切换则本地升级 T0 打开宵禁窗口
    curfew_escalate_at: Cell<Option<Instant>>,
    gui_cmd_tx: mpsc::Sender<GuiCmd>,
}

impl WindowManager {
    pub fn new(
        shared: Arc<RwLock<SharedState>>,
        gui_cmd_tx: mpsc::Sender<GuiCmd>,
        tray: Option<Tray>,
    ) -> Self {
        let settings = SettingsWindow::new().expect("SettingsWindow");
        let pill = PillWindow::new().expect("PillWindow");
        let preview = PillPreviewWindow::new().expect("PillPreviewWindow");
        let curfew = CurfewWindow::new().expect("CurfewWindow");
        let sleep_confirm = SleepConfirmWindow::new().expect("SleepConfirmWindow");
        let context_switch = PromptDialog::new().expect("ContextSwitchDialog");
        let intent_capture = PromptDialog::new().expect("IntentCaptureDialog");
        let toast = Toast::new().expect("Toast");

        // 通用弹窗静态配置（每次打开时的动态文本由 watch 层注入）
        context_switch.set_title_text("状态切换".into());
        context_switch.set_timeout_hint("后自动跳过，输入后取消倒计时".into());
        context_switch.set_submit_label("提交".into());
        context_switch.set_skip_label("跳过".into());
        intent_capture.set_title_text("睡前意图".into());
        intent_capture.set_timeout_hint("后自动关闭，可从托盘菜单重开".into());
        intent_capture.set_submit_label("保存意图".into());
        intent_capture.set_skip_label("稍后".into());

        // ── 通用拖拽/关闭 ──
        settings.on_drag_to({
            let w = settings.as_weak();
            move |dx, dy| {
                if let Some(w) = upgraded(&w, "settings") {
                    move_window(&w, dx, dy);
                }
            }
        });
        settings.on_close_requested({
            let w = settings.as_weak();
            let pw = preview.as_weak();
            move || {
                // 未保存关闭：示意窗一并关闭（UI 位置属性不回写，下次打开从 config 重载即回滚）
                if let Some(pw) = upgraded(&pw, "pill-preview") {
                    hide_win(&pw, "pill-preview");
                }
                if let Some(w) = upgraded(&w, "settings") {
                    hide_win(&w, "settings");
                }
            }
        });

        // ── 设置：保存 ──
        let pill_position = Rc::new(Cell::new(config::load().pill_position));
        settings.on_save_clicked({
            let w = settings.as_weak();
            let pw = preview.as_weak();
            let tx = gui_cmd_tx.clone();
            let pill_position = Rc::clone(&pill_position);
            move || {
                let Some(s) = upgraded(&w, "settings") else { return };
                let pos = PillPosition::from_index(s.get_pill_position());
                pill_position.set(pos);
                // v2 数据密钥由配对自动下发，设置窗不再手动编辑，保存时沿用现有配置
                let prev = config::load();
                let cfg = Config {
                    config_version: 1,
                    server_url: s.get_server_url().trim().to_owned(),
                    autostart: s.get_autostart(),
                    tracking_enabled: s.get_tracking_enabled(),
                    notifications_enabled: s.get_notifications_enabled(),
                    pill_position: pos,
                    data_key: prev.data_key,
                    token: prev.token,
                    device_name: prev.device_name,
                    paired_at: prev.paired_at,
                };
                let _ = tx.try_send(GuiCmd::SaveSettings(Box::new(cfg)));
                // 保存确认：关闭位置示意窗
                if let Some(pw) = upgraded(&pw, "pill-preview") {
                    hide_win(&pw, "pill-preview");
                }
                s.set_saved(true);
                let w2 = w.clone();
                slint::Timer::single_shot(Duration::from_secs(2), move || {
                    if let Some(w2) = upgraded(&w2, "settings") {
                        w2.set_saved(false);
                    }
                });
            }
        });

        // ── 设置：发起配对 ──
        settings.on_pair_clicked({
            let w = settings.as_weak();
            let tx = gui_cmd_tx.clone();
            move || {
                let Some(s) = upgraded(&w, "settings") else { return };
                let code = s.get_pair_code().trim().to_owned();
                if code.is_empty() {
                    s.set_pair_status("请输入 8 位配对码".into());
                    return;
                }
                let server_url = s.get_server_url().trim().to_owned();
                if server_url.is_empty() {
                    s.set_pair_status("请先填写服务器地址".into());
                    return;
                }
                let device_name = s.get_device_name().trim().to_owned();
                let device_name = if device_name.is_empty() {
                    config::default_device_name()
                } else {
                    device_name
                };
                s.set_pair_status("配对中…".into());
                let _ = tx.try_send(GuiCmd::PairRequest {
                    server_url,
                    code,
                    device_name,
                });
            }
        });

        // ── 设置：倒计时位置变更 → 临时示意窗预览 ──
        settings.on_position_preview_changed({
            let pw = preview.as_weak();
            move |i| {
                let Some(p) = upgraded(&pw, "pill-preview") else { return };
                if let Some((x, y)) = pill_anchor(PillPosition::from_index(i)) {
                    p.window().set_position(slint::PhysicalPosition::new(x, y));
                }
                if !p.window().is_visible() {
                    show_win(&p, "pill-preview");
                    if let Some(hwnd) = winpatch::hwnd_of(p.window()) {
                        unsafe { winpatch::patch_click_through(hwnd) };
                    }
                }
                p.window().request_redraw();
            }
        });

        // ── 宵禁：强制解锁（带原因） ──
        curfew.on_unlock_requested({
            let w = curfew.as_weak();
            let tx = gui_cmd_tx.clone();
            let shared = Arc::clone(&shared);
            move |reason| {
                let _ = tx.try_send(GuiCmd::SunsetRelease(reason.to_string()));
                // 本地立即解除：断线时 release 到不了服务器，不能把用户锁到重连
                if let Ok(mut g) = shared.write() {
                    g.sunset_phase = SunsetPhase::Off;
                    g.sunset_expires_at = 0;
                }
                if let Some(w) = upgraded(&w, "curfew") {
                    hide_win(&w, "curfew");
                }
            }
        });

        // ── 宵禁：阻止 Alt+F4 关闭（必须通过强制解锁流程） ──
        curfew.on_close_requested(|| {});

        // ── 入睡确认：「还没睡」 ──
        sleep_confirm.on_not_yet_requested({
            let w = sleep_confirm.as_weak();
            let tx = gui_cmd_tx.clone();
            move || {
                let _ = tx.try_send(GuiCmd::SleepConfirmNotYet);
                if let Some(w) = upgraded(&w, "sleep-confirm") {
                    hide_win(&w, "sleep-confirm");
                }
            }
        });

        // ── 入睡确认：允许用户关闭窗口（等同于「还没睡」） ──
        sleep_confirm.on_close_requested({
            let w = sleep_confirm.as_weak();
            let tx = gui_cmd_tx.clone();
            move || {
                let _ = tx.try_send(GuiCmd::SleepConfirmNotYet);
                if let Some(w) = upgraded(&w, "sleep-confirm") {
                    hide_win(&w, "sleep-confirm");
                }
            }
        });

        // ── 通用计时弹窗：状态切换 / 睡前意图 ──
        Self::wire_prompt_dialog(
            &context_switch,
            &shared,
            &gui_cmd_tx,
            |g| g.context_switch.clone(),
            |tx, p, text| {
                let (action, payload) = if text.is_empty() { ("skip", None) } else { ("submit", Some(text)) };
                let _ = tx.try_send(GuiCmd::ContextSwitchResponse { prompt_id: p.prompt_id, action, text: payload });
            },
            |tx, p| {
                let _ = tx.try_send(GuiCmd::ContextSwitchResponse { prompt_id: p.prompt_id, action: "skip", text: None });
            },
            {
                let shared = Arc::clone(&shared);
                move |tx, p| {
                    let _ = tx.try_send(GuiCmd::ContextSwitchInput { prompt_id: p.prompt_id.clone() });
                    if let Ok(mut g) = shared.write() {
                        g.context_switch_input_sent = true;
                    }
                }
            },
        );
        // prompt_id 为空串 = 本地重开：仅本地关闭，不上报 skip / 接管
        Self::wire_prompt_dialog(
            &intent_capture,
            &shared,
            &gui_cmd_tx,
            |g| g.intent_capture.clone(),
            {
                let shared = Arc::clone(&shared);
                move |tx, p, text| {
                    if text.is_empty() {
                        if !p.prompt_id.is_empty() {
                            let _ = tx.try_send(GuiCmd::IntentCaptureResponse { prompt_id: p.prompt_id, action: "skip" });
                        } else if let Ok(mut g) = shared.write() {
                            // 本地重开空提交 = 取消，清状态防 sync 循环重开
                            if matches!(&g.intent_capture, Some(x) if x.prompt_id.is_empty()) {
                                g.intent_capture = None;
                            }
                        }
                    } else {
                        let _ = tx.try_send(GuiCmd::IntentSubmit {
                            content: text,
                            prompt_id: if p.prompt_id.is_empty() { None } else { Some(p.prompt_id) },
                        });
                    }
                }
            },
            {
                let shared = Arc::clone(&shared);
                move |tx, p| {
                    if p.prompt_id.is_empty() {
                        if let Ok(mut g) = shared.write() {
                            if matches!(&g.intent_capture, Some(x) if x.prompt_id.is_empty()) {
                                g.intent_capture = None;
                            }
                        }
                    } else {
                        let _ = tx.try_send(GuiCmd::IntentCaptureResponse { prompt_id: p.prompt_id, action: "skip" });
                    }
                }
            },
            {
                let shared = Arc::clone(&shared);
                move |tx, p| {
                    if p.prompt_id.is_empty() {
                        return;
                    }
                    let _ = tx.try_send(GuiCmd::IntentInput { prompt_id: p.prompt_id.clone() });
                    if let Ok(mut g) = shared.write() {
                        g.intent_input_sent = true;
                    }
                }
            },
        );

        let notifications_enabled = config::load().notifications_enabled;
        Self {
            shared,
            tray: RefCell::new(tray),
            settings,
            pill,
            preview,
            curfew,
            sleep_confirm,
            context_switch,
            intent_capture,
            toast,
            timer: slint::Timer::default(),
            last_phase: Cell::new(SunsetPhase::Off),
            notifier: RefCell::new(None),
            notifications_enabled,
            pill_position,
            last_pill_pos: Cell::new(None),
            last_pill_text: RefCell::new(String::new()),
            last_tooltip: RefCell::new(String::new()),
            last_curfew_refresh: Cell::new(None),
            last_pair_invalid: Cell::new(false),
            curfew_escalate_at: Cell::new(None),
            gui_cmd_tx,
        }
    }

    /// 启动 1s 同步循环
    pub fn wire_self(self: &Rc<Self>) {
        let wm = Rc::clone(self);
        self.timer
            .start(slint::TimerMode::Repeated, Duration::from_secs(1), move || {
                wm.sync();
            });
    }

    /// 显示 toast 弹窗
    pub fn show_toast(&self, title: &str, body: &str) {
        self.toast.set_title_text(title.into());
        self.toast.set_body_text(body.into());
        self.toast.set_autohide_delay(5);
        let _ = self.toast.show();
        // toast 关闭回调
        let toast_weak = self.toast.as_weak();
        self.toast.on_close_requested({
            move || {
                if let Some(t) = toast_weak.upgrade() {
                    let _ = t.hide();
                }
            }
        });
    }

    /// 通用计时弹窗接线：从 shared 读当前弹窗状态，提交/跳过/开始输入分发给各弹窗回调
    fn wire_prompt_dialog(
        win: &PromptDialog,
        shared: &Arc<RwLock<SharedState>>,
        tx: &mpsc::Sender<GuiCmd>,
        get_state: impl Fn(&SharedState) -> Option<crate::shared::PromptDialogState> + 'static,
        on_submit: impl Fn(&mpsc::Sender<GuiCmd>, crate::shared::PromptDialogState, String) + 'static,
        on_skip: impl Fn(&mpsc::Sender<GuiCmd>, crate::shared::PromptDialogState) + 'static,
        on_input: impl Fn(&mpsc::Sender<GuiCmd>, &crate::shared::PromptDialogState) + 'static,
    ) {
        let get_state = Rc::new(get_state);
        let on_skip = Rc::new(on_skip);
        let on_input = Rc::new(on_input);
        win.on_submit_requested({
            let w = win.as_weak();
            let tx = tx.clone();
            let shared = Arc::clone(shared);
            let get_state = Rc::clone(&get_state);
            move |text| {
                if let Some(p) = shared.read().ok().and_then(|g| get_state(&g)) {
                    on_submit(&tx, p, text.trim().to_owned());
                }
                if let Some(w) = upgraded(&w, "prompt") {
                    hide_win(&w, "prompt");
                }
            }
        });
        win.on_skip_requested({
            let w = win.as_weak();
            let tx = tx.clone();
            let shared = Arc::clone(shared);
            let get_state = Rc::clone(&get_state);
            let on_skip = Rc::clone(&on_skip);
            move || {
                if let Some(p) = shared.read().ok().and_then(|g| get_state(&g)) {
                    on_skip(&tx, p);
                }
                if let Some(w) = upgraded(&w, "prompt") {
                    hide_win(&w, "prompt");
                }
            }
        });
        // ── 允许 Alt+F4 关闭（等同于跳过） ──
        win.on_close_requested({
            let w = win.as_weak();
            let tx = tx.clone();
            let shared = Arc::clone(shared);
            let get_state = Rc::clone(&get_state);
            let on_skip = Rc::clone(&on_skip);
            move || {
                if let Some(p) = shared.read().ok().and_then(|g| get_state(&g)) {
                    on_skip(&tx, p);
                }
                if let Some(w) = upgraded(&w, "prompt") {
                    hide_win(&w, "prompt");
                }
            }
        });
        // ── 首次输入：接管信号（本地立即置标志，避免自身 typing 广播清空状态） ──
        win.on_input_started({
            let tx = tx.clone();
            let shared = Arc::clone(shared);
            let get_state = Rc::clone(&get_state);
            let on_input = Rc::clone(&on_input);
            move || {
                let Some(p) = shared.read().ok().and_then(|g| get_state(&g)) else { return };
                on_input(&tx, &p);
            }
        });
    }

    // ─── 托盘命令入口 ────────────────────────────────────────

    pub fn open_settings(&self) {
        let cfg = config::load();
        self.settings.set_server_url(cfg.server_url.clone().into());
        self.settings
            .set_key_fingerprint(key_fingerprint(cfg.data_key.as_deref()).into());
        self.settings.set_autostart(cfg.autostart);
        self.settings.set_tracking_enabled(cfg.tracking_enabled);
        self.settings.set_notifications_enabled(cfg.notifications_enabled);
        self.settings.set_pill_position(cfg.pill_position.to_index());
        // 配对区
        let paired = cfg.is_paired();
        self.settings.set_paired(paired);
        let device_name = cfg
            .device_name
            .clone()
            .unwrap_or_else(config::default_device_name);
        self.settings.set_device_name(device_name.clone().into());
        self.settings.set_pair_code("".into());
        self.settings.set_pair_status("".into());
        self.settings.set_paired_info(
            format!("{} · {}", device_name, cfg.server_url).into(),
        );
        self.settings.set_saved(false);
        // 防御：每次打开设置时示意窗从隐藏态开始
        hide_win(&self.preview, "pill-preview");
        show_win(&self.settings, "settings");
        self.settings.window().request_redraw();
        if let Some(hwnd) = winpatch::hwnd_of(self.settings.window()) {
            winpatch::activate(hwnd);
        }
    }

    // ─── 1s 同步循环 ─────────────────────────────────────────

    fn sync(&self) {
        let snap = match self.shared.read() {
            Ok(g) => (
                g.connected,
                g.config_error.clone(),
                g.user_state.clone(),
                g.sunset_phase,
                g.target_bedtime_minutes,
                g.queued_offline,
                g.last_ai_message.clone(),
                g.sleep_confirm_until,
                g.sunset_expires_at,
                g.context_switch.clone(),
                g.intent_capture.clone(),
            ),
            Err(_) => return,
        };
        let (_connected, config_error, user_state, mut phase, target, _queued, _ai_msg, sleep_confirm_until, expires_at, cs_prompt, ic_prompt) = snap;

        // 托盘「写睡前意图」fetch 完成后打开弹窗并预填
        if let Ok(mut g) = self.shared.write() {
            if let Some(prefill) = g.intent_today_prefill.take() {
                if g.intent_capture.is_none() {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    g.intent_capture = Some(crate::shared::PromptDialogState {
                        prompt_id: String::new(),
                        text: prefill,
                        deadline: now + 120, // 无超时限制，120s 兜底
                    });
                }
            }
        }

        // 配置错误 toast 提示（仅首次检测到时显示）
        if let Some(err) = &config_error {
            if !self.toast.window().is_visible() {
                self.show_toast("Anchor 配置错误", err);
            }
        }

        // 配对操作反馈 → 设置窗状态文字
        let pair_status = if let Ok(mut g) = self.shared.write() {
            g.pair_status.take()
        } else {
            None
        };
        if let Some(st) = pair_status {
            let text = match (&st.server_version, st.ok) {
                (Some(ver), true) => format!("配对成功 · 服务器版本 {ver}"),
                _ => st.message.clone(),
            };
            self.settings.set_pair_status(text.into());
            self.settings.set_paired(st.ok);
            if st.ok {
                let cfg = config::load();
                let device_name = cfg
                    .device_name
                    .clone()
                    .unwrap_or_else(config::default_device_name);
                self.settings.set_paired_info(
                    format!("{} · {}", device_name, cfg.server_url).into(),
                );
                self.settings
                    .set_key_fingerprint(key_fingerprint(cfg.data_key.as_deref()).into());
            }
        }

        // 配对失效：托盘提示（daemon 已入 pending_notifications）+ 打开设置窗引导重新配对
        let pair_invalid = self
            .shared
            .read()
            .map(|g| g.pair_invalid)
            .unwrap_or(false);
        if pair_invalid && !self.last_pair_invalid.get() {
            self.open_settings();
        }
        self.last_pair_invalid.set(pair_invalid);

        // 宵禁过期守护：expires_at 已过则本地解除（服务器离线兜底，不永久锁屏）
        if phase != SunsetPhase::Off && expires_at > 0 {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            if now > expires_at {
                log::info!("[sunset] expires_at 已过，本地解除宵禁（断线兜底）");
                if let Ok(mut g) = self.shared.write() {
                    g.sunset_phase = SunsetPhase::Off;
                    g.sunset_expires_at = 0;
                }
                phase = SunsetPhase::Off;
            }
        }

        // 托盘图标 / tooltip / 气泡通知
        if let Some(tray) = self.tray.borrow_mut().as_mut() {
            tray.set_phase(phase);
            tray.set_state(user_state.as_deref());
            let tooltip = if phase != SunsetPhase::Off {
                format!("距就寝还有 {} 分钟", tray::remaining_minutes(target))
            } else {
                "Anchor".to_owned()
            };
            if *self.last_tooltip.borrow() != tooltip {
                tray.set_tooltip(&tooltip);
                *self.last_tooltip.borrow_mut() = tooltip;
            }
            if let Ok(mut g) = self.shared.write() {
                tray::drain_notifications(tray, &mut g, self.notifications_enabled);
            }
        }

        self.watch_sunset(phase, target);
        self.watch_sleep_confirm(sleep_confirm_until);

        // winddown 倒数归零后的本地升级兜底：remaining_minutes 归零即「到点」，
        // 服务器 T0 广播最晚 1 个轻量 tick（60s）到达，宽限 90s 仍未切换则本地升级
        // T0 打开宵禁窗口（对齐 expires_at 断线兜底语义，避免倒计时归零后
        // 宵禁窗口永远不出现）
        if matches!(phase, SunsetPhase::T60 | SunsetPhase::T30 | SunsetPhase::T15)
            && target > 0
            && target < 24 * 60
            && tray::remaining_minutes(target) == 0
        {
            if self.curfew_escalate_at.get().is_none() {
                self.curfew_escalate_at
                    .set(Some(Instant::now() + Duration::from_secs(90)));
            }
        } else {
            self.curfew_escalate_at.set(None);
        }
        if let Some(deadline) = self.curfew_escalate_at.get() {
            if Instant::now() >= deadline {
                self.curfew_escalate_at.set(None);
                log::warn!("[sunset] 倒数归零后服务器未推送 T0，本地升级打开宵禁窗口");
                if let Ok(mut g) = self.shared.write() {
                    g.sunset_phase = SunsetPhase::T0;
                    g.sunset_expires_at = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64 + 8 * 60 * 60)
                        .unwrap_or(0);
                }
            }
        }
        self.refresh_curfew_if_needed(phase);

        // 状态切换弹窗：正文固定，占位提示随 prompt 注入；超时恒 auto_skip 上报
        self.watch_prompt_dialog(&self.context_switch, cs_prompt, |win, p| {
            win.set_body_text("你似乎从工作切换到了其他状态。方便说一下接下来的打算吗？".into());
            win.set_placeholder_text(p.text.clone().into());
        }, |wm, p| {
            let _ = wm.gui_cmd_tx.try_send(GuiCmd::ContextSwitchResponse {
                prompt_id: p.prompt_id.clone(),
                action: "auto_skip",
                text: None,
            });
            if let Ok(mut g) = wm.shared.write() {
                if matches!(&g.context_switch, Some(x) if x.prompt_id == p.prompt_id) {
                    g.context_switch = None;
                }
            }
        });

        // 睡前意图弹窗：正文随 prompt 注入，占位固定；prompt_id 空串（本地重开）超时仅本地隐藏
        self.watch_prompt_dialog(&self.intent_capture, ic_prompt, |win, p| {
            if p.prompt_id.is_empty() {
                // 本地重开：有内容 = 修改今日意图，无内容 = 新写
                win.set_title_text(if p.text.is_empty() { "睡前意图" } else { "修改睡前意图" }.into());
                win.set_body_text(p.text.clone().into());
                win.set_input_text(p.text.clone().into());
            } else {
                win.set_title_text("睡前意图".into());
                win.set_body_text(p.text.clone().into());
                win.set_input_text("".into());
            }
            win.set_placeholder_text("例如：明天优先完成 API 文档和 review PR".into());
        }, |wm, p| {
            // 本地重开超时（或手动关闭）仅本地清状态，避免 sync 循环重开
            if let Ok(mut g) = wm.shared.write() {
                if matches!(&g.intent_capture, Some(x) if x.prompt_id == p.prompt_id) {
                    g.intent_capture = None;
                }
            }
            if p.prompt_id.is_empty() {
                return;
            }
            let _ = wm.gui_cmd_tx.try_send(GuiCmd::IntentCaptureResponse {
                prompt_id: p.prompt_id.clone(),
                action: "auto_skip",
            });
        });

        // pill 倒计时文本 + 位置（设置保存后 1s 内生效）
        if self.pill.window().is_visible() {
            let text = format!("就寝 {} 分钟", tray::remaining_minutes(target));
            if *self.last_pill_text.borrow() != text {
                self.pill.set_text(text.clone().into());
                *self.last_pill_text.borrow_mut() = text;
            }
            self.position_pill();
        }
    }

    /// 入睡确认窗口：sleep_confirm_until 未到期则居中置顶显示；到期/清空则隐藏（本地兜底销毁）
    fn watch_sleep_confirm(&self, until: Option<i64>) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let active = matches!(until, Some(u) if u > now);

        if active && !self.sleep_confirm.window().is_visible() {
            // 居中到工作区
            if let Some((w, h)) = ui::work_area() {
                self.sleep_confirm.window().set_position(slint::PhysicalPosition::new(
                    ((w - 360.0) / 2.0) as i32,
                    ((h - 170.0) / 2.0) as i32,
                ));
            }
            show_win(&self.sleep_confirm, "sleep-confirm");
            self.sleep_confirm.window().request_redraw();
            if let Some(hwnd) = winpatch::hwnd_of(self.sleep_confirm.window()) {
                unsafe { winpatch::patch_topmost(hwnd) };
            }
        } else if !active && self.sleep_confirm.window().is_visible() {
            hide_win(&self.sleep_confirm, "sleep-confirm");
            if until.is_some() {
                if let Ok(mut g) = self.shared.write() {
                    g.sleep_confirm_until = None;
                }
            }
        }
    }

    /// 通用计时弹窗同步：有活跃 prompt 则居中置顶显示；dismiss/响应/到期后销毁。
    /// 未输入时按 deadline 倒计时，到期调用 on_timeout 并隐藏；一旦输入（typed）倒计时停止，只能手动操作。
    /// configure：每次打开前注入动态文本（body/placeholder）。
    fn watch_prompt_dialog(
        &self,
        win: &PromptDialog,
        prompt: Option<crate::shared::PromptDialogState>,
        configure: impl Fn(&PromptDialog, &crate::shared::PromptDialogState),
        on_timeout: impl Fn(&WindowManager, &crate::shared::PromptDialogState),
    ) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        match prompt {
            Some(p) => {
                if !win.window().is_visible() {
                    win.set_typed(false);
                    configure(win, &p);
                    if let Some((w, h)) = ui::work_area() {
                        win.window().set_position(slint::PhysicalPosition::new(
                            ((w - 420.0) / 2.0) as i32,
                            ((h - 250.0) / 2.0) as i32,
                        ));
                    }
                    show_win(win, "prompt");
                    win.window().request_redraw();
                    if let Some(hwnd) = winpatch::hwnd_of(win.window()) {
                        unsafe { winpatch::patch_topmost(hwnd) };
                    }
                }

                if win.get_typed() {
                    return;
                }

                let remaining = p.deadline - now;
                if remaining <= 0 {
                    on_timeout(self, &p);
                    hide_win(win, "prompt");
                } else {
                    win.set_remaining(remaining as i32);
                }
            }
            None => {
                // 用户已输入（typed）：弹窗保留到手动提交/跳过（服务器 dismiss/接管广播均不关闭）；
                // 未输入时按 dismiss/接管广播正常关闭
                if win.window().is_visible() && !win.get_typed() {
                    hide_win(win, "prompt");
                }
            }
        }
    }

    /// 托盘菜单/气球点击重开睡前意图弹窗（本地重开，60s 倒计时，不上报超时）
    #[allow(dead_code)]
    pub fn reopen_intent(&self) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        if let Ok(mut g) = self.shared.write() {
            // 已有活跃弹窗时不重复打开
            if g.intent_capture.is_some() {
                return;
            }
            let Some(prompt) = g.intent_reopen.clone() else { return };
            log::info!("[intent] 用户从托盘重开睡前意图弹窗");
            g.intent_capture = Some(crate::shared::PromptDialogState {
                prompt_id: String::new(),
                text: prompt,
                deadline: now + 60,
            });
        }
    }

    /// 宵禁阶段监听：驱动 pill / curfew / 提醒定时器
    fn watch_sunset(&self, phase: SunsetPhase, target: i64) {
        if phase != self.last_phase.get() {
            log::info!("[sunset] 阶段切换 {:?} → {:?}", self.last_phase.get(), phase);
            match phase {
                SunsetPhase::T60 | SunsetPhase::T30 | SunsetPhase::T15 => {
                    self.open_pill(phase);
                    hide_win(&self.curfew, "curfew");
                    self.fire_sunset_notification(phase, target);
                    *self.notifier.borrow_mut() = Some((phase, Instant::now()));
                }
                SunsetPhase::T0 => {
                    hide_win(&self.pill, "pill");
                    *self.notifier.borrow_mut() = None;
                    self.open_curfew(target);
                }
                SunsetPhase::Off => {
                    hide_win(&self.pill, "pill");
                    hide_win(&self.curfew, "curfew");
                    *self.notifier.borrow_mut() = None;
                    self.last_curfew_refresh.set(None);
                }
            }
            self.last_phase.set(phase);
        }

        // 提醒定时器：T60 每 20 分钟，T30 每 10 分钟，T15 每 5 分钟
        // 注意：borrow() 须在独立语句中取值，若直接放进 if let scrutinee，
        // Ref guard 会活到整个 if let 块结束，导致块内 borrow_mut() panic
        let notifier = *self.notifier.borrow();
        if let Some((nphase, last)) = notifier {
            let interval = if nphase == SunsetPhase::T60 {
                Duration::from_secs(20 * 60)
            } else if nphase == SunsetPhase::T15 {
                Duration::from_secs(5 * 60)
            } else {
                Duration::from_secs(10 * 60)
            };
            if last.elapsed() >= interval {
                self.fire_sunset_notification(nphase, target);
                *self.notifier.borrow_mut() = Some((nphase, Instant::now()));
            }
        }
    }

    fn open_pill(&self, phase: SunsetPhase) {
        self.pill.set_accent(match phase {
            SunsetPhase::T60 => slint::Color::from_rgb_u8(0xc0, 0x62, 0x2a),
            _ => slint::Color::from_rgb_u8(0xcf, 0x22, 0x2e),
        });
        self.position_pill();
        show_win(&self.pill, "pill");
        self.pill.window().request_redraw();
        if let Some(hwnd) = winpatch::hwnd_of(self.pill.window()) {
            unsafe { winpatch::patch_click_through(hwnd) };
            log::info!("pill 窗口已打补丁（穿透/无激活/置顶）");
        }
    }

    /// 按配置把 pill 放到工作区对应角落/中上，边距 16px
    /// 仅当坐标真正变化时才调用 set_position，避免每秒重复触发窗口管理器
    fn position_pill(&self) {
        if let Some((x, y)) = pill_anchor(self.pill_position.get()) {
            if self.last_pill_pos.get() != Some((x, y)) {
                self.pill
                    .window()
                    .set_position(slint::PhysicalPosition::new(x, y));
                self.last_pill_pos.set(Some((x, y)));
            }
        }
    }

    fn open_curfew(&self, target: i64) {
        self.curfew.set_bedtime(
            format!("{:02}:{:02}", (target / 60) % 24, target % 60).into(),
        );
        let (w, h) = winpatch::screen_size();
        self.curfew
            .window()
            .set_size(slint::PhysicalSize::new(w as u32, h as u32));
        self.curfew
            .window()
            .set_position(slint::PhysicalPosition::new(0, 0));
        show_win(&self.curfew, "curfew");
        self.curfew.window().request_redraw();
        if let Some(hwnd) = winpatch::hwnd_of(self.curfew.window()) {
            unsafe { winpatch::patch_topmost(hwnd) };
            log::info!("curfew 窗口已置顶");
        }
        self.last_curfew_refresh.set(Some(Instant::now()));
    }

    /// 周期性刷新宵禁窗口：锁屏/切后台后 Slint 渲染缓冲可能丢失，
    /// 通过定时重绘 + 重新置顶恢复可见性。
    fn refresh_curfew_if_needed(&self, phase: SunsetPhase) {
        if phase != SunsetPhase::T0 || !self.curfew.window().is_visible() {
            return;
        }
        const REFRESH_INTERVAL: Duration = Duration::from_secs(5);
        let now = Instant::now();
        let should_refresh = match self.last_curfew_refresh.get() {
            Some(t) => now.duration_since(t) >= REFRESH_INTERVAL,
            None => true,
        };
        if should_refresh {
            self.curfew.window().request_redraw();
            if let Some(hwnd) = winpatch::hwnd_of(self.curfew.window()) {
                unsafe { winpatch::patch_topmost(hwnd) };
            }
            self.last_curfew_refresh.set(Some(now));
            log::debug!("[curfew] 周期性刷新：重绘 + 重新置顶");
        }
    }

    fn fire_sunset_notification(&self, phase: SunsetPhase, target: i64) {
        if !self.notifications_enabled {
            return;
        }
        if let Some(tray) = self.tray.borrow().as_ref() {
            let remaining = tray::remaining_minutes(target);
            let body = if phase == SunsetPhase::T15 {
                format!("距就寝还有 {remaining} 分钟，高刺激内容即将被拦截")
            } else {
                format!("距就寝还有 {remaining} 分钟，建议开始收尾")
            };
            tray.balloon(
                "Anchor 宵禁提醒",
                &body,
                phase == SunsetPhase::T60, // T60 静默，T30/T15 有声
            );
        }
    }
}

/// 数据密钥指纹：sha256(key) 的 base64 前 8 位，与服务器/packages/utils crypto.ts 口径一致；
/// 未配对（无密钥）返回空串
fn key_fingerprint(data_key: Option<&str>) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use sha2::Digest;
    let Some(key) = data_key else { return String::new() };
    let digest = sha2::Sha256::digest(key.as_bytes());
    STANDARD.encode(digest)[..8].to_owned()
}

/// pill 尺寸与边距（与 ui/pill.slint、ui/pill-preview.slint 保持一致）
const PILL_W: f32 = 140.0;
const PILL_H: f32 = 40.0;
const PILL_MARGIN: f32 = 16.0;

/// 计算 pill/示意窗在工作区对应角落/中上的物理像素坐标
/// work_area 是物理像素，PILL_* 是逻辑像素，需乘 DPI 缩放系数
fn pill_anchor(pos: PillPosition) -> Option<(i32, i32)> {
    let (w, h) = ui::work_area()?;
    let s = ui::primary_scale();
    let pw = PILL_W * s;
    let ph = PILL_H * s;
    let m = PILL_MARGIN * s;
    let (x, y) = match pos {
        PillPosition::TopLeft => (m, m),
        PillPosition::TopCenter => ((w - pw) / 2.0, m),
        PillPosition::TopRight => (w - pw - m, m),
        PillPosition::BottomLeft => (m, h - ph - m),
        PillPosition::BottomRight => (w - pw - m, h - ph - m),
    };
    Some((x as i32, y as i32))
}

/// 标题栏拖拽：逻辑像素偏移 → 物理像素位移
fn move_window(win: &impl slint::ComponentHandle, dx: f32, dy: f32) {
    let window = win.window();
    let scale = window.scale_factor();
    let pos = window.position();
    window.set_position(slint::PhysicalPosition::new(
        pos.x + (dx * scale) as i32,
        pos.y + (dy * scale) as i32,
    ));
}

/// 安全升级 Slint 弱引用；失败时记录警告并返回 None
fn upgraded<T: slint::ComponentHandle>(weak: &slint::Weak<T>, name: &str) -> Option<T> {
    weak.upgrade().or_else(|| {
        log::warn!("[wm] {name} 窗口弱引用已失效");
        None
    })
}

/// 安全显示窗口：避免单个窗口操作失败导致整个进程 panic 退出
fn show_win(win: &impl slint::ComponentHandle, name: &str) {
    if let Err(e) = win.show() {
        log::warn!("[wm] 显示 {name} 窗口失败: {e:?}");
    }
}

/// 安全隐藏窗口
fn hide_win(win: &impl slint::ComponentHandle, name: &str) {
    if let Err(e) = win.hide() {
        log::warn!("[wm] 隐藏 {name} 窗口失败: {e:?}");
    }
}
