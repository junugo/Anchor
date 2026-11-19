//! 后台 daemon：WS / 行为采集 / 离线队列 / 状态机 的编排核心
//!
//! 通信模型：
//! - tracking task → ingest channel → core：core 决定直发 WS 或入离线队列
//! - ws task ↔ core：WsEvent（带代际号，重连后忽略旧代事件）
//! - GUI → core：GuiCmd（宵禁破戒 / 设置）
//! - core → GUI：写 SharedState（Arc<RwLock>），GUI 侧 1s 定时轮询同步

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use tokio::sync::mpsc;

use crate::config;
use crate::offline::{OfflineQueue, MAX_RETRIES};
use crate::shared::SharedState;
use crate::shutdown;
use crate::state;
use crate::tracking::{self, FocusTracker};
use crate::ws::{self, WsEvent, WsEventKind};

/// GUI → daemon 命令
#[derive(Debug)]
pub enum GuiCmd {
    /// 宵禁强制解锁（带原因，服务器广播 off 全端同步）
    SunsetRelease(String),
    /// 入睡确认框「还没睡」响应
    SleepConfirmNotYet,
    /// 状态切换弹窗响应（submit/skip/auto_skip，服务器先到先赢并全端广播关闭）
    ContextSwitchResponse {
        prompt_id: String,
        action: &'static str,
        text: Option<String>,
    },
    /// 睡前意图提交（服务器存库并广播 dismiss answered 全端关闭）
    IntentSubmit {
        content: String,
        /// 活跃捕获的 prompt_id；本地重开提交时为 None
        prompt_id: Option<String>,
    },
    /// 睡前意图弹窗响应（skip/auto_skip，服务器先到先赢并全端广播关闭）
    IntentCaptureResponse {
        prompt_id: String,
        action: &'static str,
    },
    /// 状态切换弹窗开始输入（接管）：上报 input 信号，其他端关闭
    ContextSwitchInput {
        prompt_id: String,
    },
    /// 睡前意图弹窗开始输入（接管）：上报 input 信号，其他端关闭
    IntentInput {
        prompt_id: String,
    },
    /// 保存桌面端设置（可能触发 WS 重连 / 追踪开关）
    SaveSettings(Box<config::Config>),
    /// 发起配对：POST /api/pair 兑换配对码，成功后写配置并重连 WS
    PairRequest {
        server_url: String,
        code: String,
        device_name: String,
    },
}

pub async fn run(shared: Arc<RwLock<SharedState>>, mut gui_cmd_rx: mpsc::Receiver<GuiCmd>) {
    let mut cfg = config::load();
    apply_autostart(&cfg);

    let queue = match OfflineQueue::open() {
        Ok(q) => Some(q),
        Err(e) => {
            log::error!("离线队列打开失败（离线缓存不可用）: {e}");
            None
        }
    };

    let (mut to_ws_tx, to_ws_rx) = mpsc::channel::<String>(256);
    let (ws_ev_tx, mut ws_ev_rx) = mpsc::channel::<WsEvent>(64);
    let (ingest_tx, mut ingest_rx) = mpsc::channel::<String>(256);

    let mut ws_gen: u32 = 0;
    // 未配对不上报：WS 任务只在已配对时启动
    let mut ws_running = cfg.is_paired();
    if ws_running {
        log::info!("WS 目标: {}", config::ws_url(&cfg.server_url));
        tokio::spawn(ws::run(
            config::ws_url(&cfg.server_url),
            cfg.token.clone(),
            to_ws_rx,
            ws_ev_tx.clone(),
            ws_gen,
        ));
    } else {
        drop(to_ws_rx);
        log::info!("未配对，跳过 WS 连接与数据上报；请在托盘菜单 → 设置中完成配对");
    }
    write_shared(&shared, |s| {
        s.paired = cfg.is_paired();
        s.pair_invalid = false;
    });

    let tracker = Arc::new(Mutex::new(FocusTracker::new()));
    shutdown::register(Arc::clone(&tracker), to_ws_tx.clone());

    let tracking_active = Arc::new(AtomicBool::new(false));
    if cfg.tracking_enabled {
        spawn_tracking(&ingest_tx, &tracker, &tracking_active);
    }

    // 自动更新检查：启动时一次 + 每 24h（ureq 阻塞调用，放 spawn_blocking）
    {
        let shared = Arc::clone(&shared);
        tokio::spawn(async move {
            loop {
                let found = tokio::task::spawn_blocking(crate::update::check_update).await.ok().flatten();
                if let Some(info) = found {
                    let version = info.version.clone();
                    write_shared(&shared, |s| {
                        // 更新中/失败态不被新结果覆盖（用户路径优先）
                        if matches!(s.update, crate::shared::UpdateStatus::Idle | crate::shared::UpdateStatus::Available(_)) {
                            s.update = crate::shared::UpdateStatus::Available(version.clone());
                            s.update_info = Some(info);
                            s.pending_notifications.push(crate::shared::PendingNotification {
                                title: format!("Anchor 发现新版本 v{version}"),
                                body: "托盘菜单点击「点击更新」自动升级".to_owned(),
                                silent: false,
                            });
                        }
                    });
                }
                tokio::time::sleep(std::time::Duration::from_secs(24 * 3600)).await;
            }
        });
    }

    let mut connected = false;
    if let Some(q) = &queue {
        sync_queue_len(q, &shared);
    }

    loop {
        // 读取当前配置错误状态
        let config_error = shared.read().ok().and_then(|s| s.config_error.clone());
        
        tokio::select! {
            text = ingest_rx.recv() => {
                let Some(text) = text else { break };
                // 上报门只看 config 真实配对态（is_paired），与展示态 shared.paired 语义不同：
                // 配对失效期间 shared.paired=false 仅用于引导重新配对，cfg.token 仍在——
                // 但此时 WS 已断开、未配对新设备前服务器不会认旧 token，数据照旧本地累积
                // （断线逻辑会入离线队列），重新配对/恢复连接后统一补发。此分裂是有意设计。
                if !cfg.is_paired() {
                    log::debug!("[ingest] 未配对，跳过本次上报（数据保留在离线队列，重配后补发）");
                    continue;
                }
                send_or_queue(connected, &config_error, &to_ws_tx, queue.as_ref(), text, true, cfg.crypto_key()).await;
                if !connected {
                    if let Some(q) = &queue {
                        sync_queue_len(q, &shared);
                    }
                }
            }

            cmd = gui_cmd_rx.recv() => {
                match cmd {
                    Some(GuiCmd::SunsetRelease(reason)) => {
                        log::warn!("[curfew] 用户强制解锁: {reason}");
                        send_or_queue(connected, &config_error, &to_ws_tx, queue.as_ref(), release_message(&reason), false, cfg.crypto_key()).await;
                    }
                    Some(GuiCmd::SleepConfirmNotYet) => {
                        log::info!("[sleep] 用户响应「还没睡」");
                        send_or_queue(connected, &config_error, &to_ws_tx, queue.as_ref(), sleep_confirm_response_message(), false, cfg.crypto_key()).await;
                        write_shared(&shared, |s| s.sleep_confirm_until = None);
                    }
                    Some(GuiCmd::ContextSwitchResponse { prompt_id, action, text }) => {
                        log::info!("[context_switch] 用户响应 {action}: {prompt_id}");
                        send_or_queue(connected, &config_error, &to_ws_tx, queue.as_ref(), context_switch_response_message(&prompt_id, action, text.as_deref()), false, cfg.crypto_key()).await;
                        write_shared(&shared, |s| {
                            if matches!(&s.context_switch, Some(p) if p.prompt_id == prompt_id) {
                                s.context_switch = None;
                            }
                        });
                    }
                    Some(GuiCmd::IntentSubmit { content, prompt_id }) => {
                        log::info!("[intent] 用户提交睡前意图");
                        send_or_queue(connected, &config_error, &to_ws_tx, queue.as_ref(), intent_submit_message(&content, prompt_id.as_deref()), false, cfg.crypto_key()).await;
                        // 本地立即清除：弹窗与重开入口
                        write_shared(&shared, |s| {
                            s.intent_capture = None;
                            s.intent_reopen = None;
                        });
                    }
                    Some(GuiCmd::IntentCaptureResponse { prompt_id, action }) => {
                        log::info!("[intent] 用户响应 {action}: {prompt_id}");
                        send_or_queue(connected, &config_error, &to_ws_tx, queue.as_ref(), intent_capture_response_message(&prompt_id, action), false, cfg.crypto_key()).await;
                        write_shared(&shared, |s| {
                            if matches!(&s.intent_capture, Some(p) if p.prompt_id == prompt_id) {
                                s.intent_capture = None;
                            }
                        });
                    }
                    Some(GuiCmd::ContextSwitchInput { prompt_id }) => {
                        log::info!("[context_switch] 用户开始输入（接管）: {prompt_id}");
                        write_shared(&shared, |s| s.context_switch_input_sent = true);
                        send_or_queue(connected, &config_error, &to_ws_tx, queue.as_ref(), context_switch_input_message(&prompt_id), false, cfg.crypto_key()).await;
                    }
                    Some(GuiCmd::IntentInput { prompt_id }) => {
                        log::info!("[intent] 用户开始输入（接管）: {prompt_id}");
                        write_shared(&shared, |s| s.intent_input_sent = true);
                        send_or_queue(connected, &config_error, &to_ws_tx, queue.as_ref(), intent_input_message(&prompt_id), false, cfg.crypto_key()).await;
                    }
                    Some(GuiCmd::SaveSettings(new_cfg)) => {
                        let new_cfg = *new_cfg;
                        let url_changed = new_cfg.server_url.trim_end_matches('/')
                            != cfg.server_url.trim_end_matches('/');
                        let token_changed = new_cfg.token != cfg.token;

                        if let Err(e) = config::save(&new_cfg) {
                            log::error!("保存配置失败: {e}");
                        }
                        if let Err(e) = crate::autostart::set_autostart(new_cfg.autostart) {
                            log::warn!("应用自启设置失败: {e}");
                        }

                        if new_cfg.tracking_enabled != cfg.tracking_enabled {
                            if new_cfg.tracking_enabled {
                                spawn_tracking(&ingest_tx, &tracker, &tracking_active);
                            } else {
                                tracking_active.store(false, Ordering::Relaxed);
                                log::info!("窗口追踪已停止");
                            }
                        }

                        cfg = new_cfg;
                        write_shared(&shared, |s| {
                            s.paired = cfg.is_paired();
                        });

                        // server_url/token 变更或未配对恢复 → 重建 WS 任务。
                        // 注意：pair_invalid 只在 WS 真正重建时才清除——
                        // 若重连条件不满足（配对仍失效），保留失效标记继续引导用户重新配对，
                        // 避免「显示已配对但永不连接」的静默死态。
                        if (url_changed || token_changed || !ws_running) && cfg.is_paired() {
                            log::info!("连接参数变更，重连 WS: {}", cfg.server_url);
                            respawn_ws(&cfg, &mut ws_gen, &ws_ev_tx, &mut to_ws_tx);
                            ws_running = true;
                            shutdown::set_to_ws(to_ws_tx.clone());
                            connected = false;
                            write_shared(&shared, |s| {
                                s.connected = false;
                                s.pair_invalid = false;
                            });
                        }
                    }
                    Some(GuiCmd::PairRequest { server_url, code, device_name }) => {
                        log::info!("[pair] 发起配对: {server_url} (设备: {device_name})");
                        let result = tokio::task::spawn_blocking({
                            let device_name = device_name.clone();
                            let pair_server_url = server_url.clone();
                            move || crate::pair::pair(&pair_server_url, &code, &device_name)
                        })
                        .await;
                        match result {
                            Ok(Ok(resp)) => {
                                log::info!("[pair] 配对成功，服务器版本 {}", resp.server_version);
                                // 服务器地址以配对时设置窗输入为准（用户可能刚改过还未点保存）
                                cfg.server_url = server_url;
                                cfg.token = Some(resp.token);
                                cfg.data_key = Some(resp.data_key);
                                cfg.device_name = Some(device_name);
                                cfg.paired_at = Some(now_i64());
                                if let Err(e) = config::save(&cfg) {
                                    log::error!("[pair] 保存配置失败: {e}");
                                }
                                write_shared(&shared, |s| {
                                    s.paired = true;
                                    s.pair_invalid = false;
                                    s.pair_status = Some(crate::shared::PairStatus {
                                        ok: true,
                                        message: "配对成功".to_owned(),
                                        server_version: Some(resp.server_version.clone()),
                                    });
                                });
                                // 以新 token 重连 WS
                                respawn_ws(&cfg, &mut ws_gen, &ws_ev_tx, &mut to_ws_tx);
                                ws_running = true;
                                shutdown::set_to_ws(to_ws_tx.clone());
                                connected = false;
                                write_shared(&shared, |s| s.connected = false);
                            }
                            Ok(Err(e)) => {
                                log::warn!("[pair] 配对失败: {e}");
                                write_shared(&shared, |s| {
                                    s.pair_status = Some(crate::shared::PairStatus {
                                        ok: false,
                                        message: e.to_string(),
                                        server_version: None,
                                    });
                                });
                            }
                            Err(e) => {
                                log::error!("[pair] 配对任务异常: {e}");
                                write_shared(&shared, |s| {
                                    s.pair_status = Some(crate::shared::PairStatus {
                                        ok: false,
                                        message: format!("配对任务异常：{e}"),
                                        server_version: None,
                                    });
                                });
                            }
                        }
                    }
                    None => {}
                }
            }

            ev = ws_ev_rx.recv() => {
                match ev {
                    Some(WsEvent { gen, kind }) => {
                        if gen != ws_gen {
                            continue; // 旧代 WS 任务的事件，忽略
                        }
                        match kind {
                            WsEventKind::Connected => {
                                connected = true;
                                shutdown::set_connected(true);
                                write_shared(&shared, |s| s.connected = true);
                                // 仅在配置正确时补发离线队列
                                let config_error = shared.read().ok().and_then(|s| s.config_error.clone());
                                if config_error.is_none() {
                                    if let Some(q) = &queue {
                                        drain_queue(q, &cfg.server_url, cfg.crypto_key()).await;
                                        sync_queue_len(q, &shared);
                                    }
                                }
                            }
                            WsEventKind::Disconnected => {
                                connected = false;
                                shutdown::set_connected(false);
                                write_shared(&shared, |s| s.connected = false);
                            }
                            WsEventKind::AuthFailed => {
                                // 配对失效：托盘提示 + 打开设置窗引导重新配对；WS 任务已自行退出
                                log::warn!("[WS] 配对失效（auth_failed/4401），停止重连，等待重新配对");
                                connected = false;
                                ws_running = false;
                                shutdown::set_connected(false);
                                write_shared(&shared, |s| {
                                    s.connected = false;
                                    s.paired = false;
                                    s.pair_invalid = true;
                                    s.pending_notifications.push(crate::shared::PendingNotification {
                                        title: "Anchor 配对已失效".to_owned(),
                                        body: "与服务器的配对已失效，请在设置中重新配对".to_owned(),
                                        silent: false,
                                    });
                                });
                            }
                            WsEventKind::Text(text) => {
                                let replies = if let Ok(mut guard) = shared.write() {
                                    state::handle_server_message(&text, &mut guard)
                                } else {
                                    Vec::new()
                                };
                                for reply in replies {
                                    let _ = to_ws_tx.send(reply.to_string()).await;
                                }
                            }
                        }
                    }
                    None => break,
                }
            }
        }
    }
}

// ─── 自启 ────────────────────────────────────────────────────

fn apply_autostart(cfg: &config::Config) {
    if cfg.autostart {
        if !crate::autostart::autostart_enabled() {
            if let Err(e) = crate::autostart::set_autostart(true) {
                log::warn!("设置开机自启失败: {e}");
            }
        }
    } else if crate::autostart::autostart_enabled() {
        let _ = crate::autostart::set_autostart(false);
    }
}

// ─── 行为采集 ────────────────────────────────────────────────

fn spawn_tracking(
    ingest_tx: &mpsc::Sender<String>,
    tracker: &Arc<Mutex<FocusTracker>>,
    active: &Arc<AtomicBool>,
) {
    active.store(true, Ordering::Relaxed);
    let ingest_tx = ingest_tx.clone();
    let tracker = Arc::clone(tracker);
    let active = Arc::clone(active);
    tokio::spawn(async move {
        tracking_loop(ingest_tx, tracker, active).await;
    });
}

async fn tracking_loop(
    ingest_tx: mpsc::Sender<String>,
    tracker: Arc<Mutex<FocusTracker>>,
    active: Arc<AtomicBool>,
) {
    log::info!("窗口追踪已启动（{}s 间隔）", tracking::COLLECT_INTERVAL.as_secs());
    let mut interval = tokio::time::interval(tracking::COLLECT_INTERVAL);
    // 本次运行已处理过图标上传的进程（小写）：内存去重，持久层在 icon 模块的 SQLite 缓存
    let mut icon_done: std::collections::HashSet<String> = std::collections::HashSet::new();
    loop {
        interval.tick().await;
        if !active.load(Ordering::Relaxed) {
            break;
        }
        let events = {
            let mut guard = match tracker.lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            guard.tick()
        };
        for event in events {
            match event {
                tracking::TrackerEvent::Ingest { event_type, payload } => {
                    let msg = serde_json::json!({
                        "type": "ingest",
                        "source": "desktop",
                        "event_type": event_type,
                        "payload": payload,
                        "logged_at": unix_now(),
                    });
                    if event_type == "window_focus" {
                        log::info!(
                            "[tracking] 结算窗口: {} ({}ms, idle={})",
                            payload["process"].as_str().unwrap_or("?"),
                            payload["duration_ms"].as_u64().unwrap_or(0),
                            payload["is_idle"].as_bool().unwrap_or(false),
                        );
                    }
                    if ingest_tx.send(msg.to_string()).await.is_err() {
                        return;
                    }
                }
                tracking::TrackerEvent::ProcessSeen { process, path } => {
                    let key = process.to_lowercase();
                    if icon_done.insert(key.clone()) {
                        tokio::task::spawn_blocking(move || {
                            crate::icon::ensure_uploaded(&key, &path);
                        });
                    }
                }
            }
        }
    }
}

// ─── 发送与队列 ──────────────────────────────────────────────

/// 统一发送入口：在线直发 WS（ingest 加密后发送）；断线时仅 ingest 事件入队（交互响应过期无效，直接丢弃）
/// config_error 为 Some 时，禁止发送和入队（配置错误状态，避免无意义重试）
/// data_key 为 None（未配对且未手动配置）时，ingest 无法加密，跳过发送
async fn send_or_queue(
    connected: bool,
    config_error: &Option<String>,
    to_ws_tx: &mpsc::Sender<String>,
    queue: Option<&OfflineQueue>,
    text: String,
    queueable: bool,
    data_key: Option<&str>,
) {
    // 配置错误状态：禁止发送和入队
    if config_error.is_some() {
        log::debug!("[offline] 配置错误，跳过发送");
        return;
    }
    if connected {
        let text = if queueable {
            match crate::crypto::encrypt_json(&text, data_key) {
                Ok(t) => t,
                Err(e) => {
                    log::warn!("[ingest] 加密失败，跳过发送: {e}");
                    return;
                }
            }
        } else {
            text
        };
        let _ = to_ws_tx.send(text).await;
    } else if queueable {
        if let Some(q) = queue {
            q.enqueue(&text);
        }
    } else {
        log::info!("[offline] 断线丢弃非 ingest 消息");
    }
}

/// 重建 WS 任务：代际 +1，新 channel 替换旧 sender（旧任务 out_rx 收 None 自动退出）
fn respawn_ws(
    cfg: &config::Config,
    ws_gen: &mut u32,
    ws_ev_tx: &mpsc::Sender<WsEvent>,
    to_ws_tx: &mut mpsc::Sender<String>,
) {
    *ws_gen += 1;
    let (new_tx, new_rx) = mpsc::channel::<String>(256);
    tokio::spawn(ws::run(
        config::ws_url(&cfg.server_url),
        cfg.token.clone(),
        new_rx,
        ws_ev_tx.clone(),
        *ws_gen,
    ));
    *to_ws_tx = new_tx;
}

fn now_i64() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn release_message(reason: &str) -> String {
    serde_json::json!({
        "type": "sunset:release",
        "reason": reason,
    })
    .to_string()
}

fn sleep_confirm_response_message() -> String {
    serde_json::json!({
        "type": "sleep:confirm-response",
        "confirmed": false,
    })
    .to_string()
}

fn context_switch_response_message(prompt_id: &str, action: &str, text: Option<&str>) -> String {
    serde_json::json!({
        "type": "context_switch:response",
        "prompt_id": prompt_id,
        "action": action,
        "text": text,
        "source": "desktop",
    })
    .to_string()
}

fn intent_submit_message(content: &str, prompt_id: Option<&str>) -> String {
    let mut v = serde_json::json!({
        "type": "intent:submit",
        "content": content,
        "source": "bedtime",
    });
    if let Some(id) = prompt_id {
        v["prompt_id"] = serde_json::Value::String(id.to_owned());
    }
    v.to_string()
}

fn intent_capture_response_message(prompt_id: &str, action: &str) -> String {
    serde_json::json!({
        "type": "intent:capture-response",
        "prompt_id": prompt_id,
        "action": action,
    })
    .to_string()
}

fn context_switch_input_message(prompt_id: &str) -> String {
    serde_json::json!({
        "type": "context_switch:input",
        "prompt_id": prompt_id,
    })
    .to_string()
}

fn intent_input_message(prompt_id: &str) -> String {
    serde_json::json!({
        "type": "intent:input",
        "prompt_id": prompt_id,
    })
    .to_string()
}

const DRAIN_CHUNK: usize = 100;

/// 重连后批量补发：分块 POST /api/ingest/batch（body 加密），成功一块删一块，失败停止。
/// 超过 MAX_RETRIES 的与非 ingest 消息（历史遗留）直接丢弃。
async fn drain_queue(queue: &OfflineQueue, server_url: &str, data_key: Option<&str>) {
    // 无密钥（未配对且未手动配置）时无法加密补发，直接跳过
    if data_key.is_none() {
        log::debug!("[offline] 未配置数据密钥，跳过批量补发");
        return;
    }
    let data_key = data_key.unwrap();
    let rows = queue.pending();
    if rows.is_empty() {
        return;
    }
    log::info!("[offline] 批量补发 {} 条积压消息", rows.len());
    let url = format!("{}/api/ingest/batch", server_url.trim_end_matches('/'));
    let mut chunk: Vec<(i64, serde_json::Value)> = Vec::with_capacity(DRAIN_CHUNK);

    for (id, body) in rows {
        if queue.retries_of(id) >= MAX_RETRIES {
            log::warn!("[offline] 丢弃重试超限的消息 #{id}");
            queue.remove(id);
            continue;
        }
        match to_batch_entry(&body) {
            Some(entry) => chunk.push((id, entry)),
            None => queue.remove(id),
        }
        if chunk.len() >= DRAIN_CHUNK && !flush_chunk(queue, &url, &mut chunk, data_key) {
            return;
        }
    }
    if !chunk.is_empty() {
        flush_chunk(queue, &url, &mut chunk, data_key);
    }
}

/// WS ingest 消息 → batch logs 条目；非 ingest 返回 None
fn to_batch_entry(body: &str) -> Option<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    if v.get("type")?.as_str()? != "ingest" {
        return None;
    }
    Some(serde_json::json!({
        "source": v.get("source").cloned().unwrap_or(serde_json::Value::Null),
        "event_type": v.get("event_type").cloned().unwrap_or(serde_json::Value::Null),
        "payload": v.get("payload").cloned().unwrap_or_else(|| serde_json::json!({})),
        "logged_at": v.get("logged_at").cloned().unwrap_or(serde_json::Value::Null),
    }))
}

/// 发送一块；成功清空并删除，失败记重试并保留后续。返回是否可以继续下一块
fn flush_chunk(
    queue: &OfflineQueue,
    url: &str,
    chunk: &mut Vec<(i64, serde_json::Value)>,
    data_key: &str,
) -> bool {
    let body = serde_json::json!({
        "logs": chunk.iter().map(|(_, v)| v.clone()).collect::<Vec<_>>()
    });
    let payload = match crate::crypto::encrypt_json(&body.to_string(), Some(data_key)) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[offline] 补发数据加密失败: {e}");
            for (id, _) in chunk.drain(..) {
                queue.bump_retry(id);
            }
            return false;
        }
    };
    let result = ureq::post(url)
        .set("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(5))
        .send_string(&payload);
    match result {
        Ok(_) => {
            for (id, _) in chunk.drain(..) {
                queue.remove(id);
            }
            true
        }
        Err(e) => {
            log::warn!("[offline] 批量补发失败，保留队列等待下次: {e}");
            for (id, _) in chunk.drain(..) {
                queue.bump_retry(id);
            }
            false
        }
    }
}

fn sync_queue_len(queue: &OfflineQueue, shared: &Arc<RwLock<SharedState>>) {
    let len = queue.len();
    write_shared(shared, |s| s.queued_offline = len);
}

fn write_shared(shared: &Arc<RwLock<SharedState>>, f: impl FnOnce(&mut SharedState)) {
    if let Ok(mut guard) = shared.write() {
        f(&mut guard);
    }
}
