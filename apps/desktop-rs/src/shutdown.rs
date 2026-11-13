//! 退出流程：结算最后一个窗口焦点（尽力上报）后退出

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::Duration;

use tokio::sync::mpsc;

use crate::tracking::FocusTracker;

static TRACKER: OnceLock<std::sync::Arc<Mutex<FocusTracker>>> = OnceLock::new();
static TO_WS: RwLock<Option<mpsc::Sender<String>>> = RwLock::new(None);
static CONNECTED: AtomicBool = AtomicBool::new(false);

pub fn register(tracker: std::sync::Arc<Mutex<FocusTracker>>, to_ws: mpsc::Sender<String>) {
    let _ = TRACKER.set(tracker);
    set_to_ws(to_ws);
}

/// server_url 变更重连后更新发送端
pub fn set_to_ws(to_ws: mpsc::Sender<String>) {
    if let Ok(mut guard) = TO_WS.write() {
        *guard = Some(to_ws);
    }
}

pub fn set_connected(connected: bool) {
    CONNECTED.store(connected, Ordering::Relaxed);
}

/// 托盘「退出」入口：flush 最后窗口 → 尽力发送 → 清理托盘图标 → 退出
pub fn request_quit() -> ! {
    log::info!("退出：结算最后窗口焦点");
    if CONNECTED.load(Ordering::Relaxed) {
        let sender = TO_WS.read().ok().and_then(|g| g.clone());
        if let (Some(tracker), Some(tx)) = (TRACKER.get(), sender) {
            let payload = tracker.lock().ok().and_then(|mut t| t.flush());
            if let Some(payload) = payload {
                let msg = serde_json::json!({
                    "type": "ingest",
                    "source": "desktop",
                    "event_type": "window_focus",
                    "payload": payload,
                    "logged_at": std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                });
                let _ = tx.try_send(msg.to_string());
                // 给 WS 写任务一点时间把消息发出去
                std::thread::sleep(Duration::from_millis(400));
            }
        }
    }
    crate::tray::remove_icon();
    std::process::exit(0)
}
