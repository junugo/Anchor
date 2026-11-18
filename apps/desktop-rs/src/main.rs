//! Anchor 桌面端（Rust + Slint 守护进程）
//!
//! 线程模型：
//! - 主线程：Slint 事件循环（run_event_loop_until_quit，零窗口常驻）
//! - 后台线程：tokio runtime（WS / 行为采集 / 离线队列）
//!
//! 通信：
//! - daemon 写 SharedState（Arc<RwLock>），wm 的 1s Timer 轮询同步到组件
//! - 托盘命令在主线程 wnd_proc 内直接派发给 wm
//! - 组件回调 → GuiCmd channel → daemon

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::exit;
use std::rc::Rc;
use std::sync::{Arc, RwLock};

use tokio::sync::mpsc;
use windows::core::w;
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
use windows::Win32::System::Threading::CreateMutexW;

mod autostart;
mod config;
mod crypto;
mod daemon;
mod filelog;
mod icon;
mod offline;
mod pair;
mod shared;
mod shutdown;
mod state;
mod tracking;
mod tray;
mod ui;
mod wm;
mod ws;

use daemon::GuiCmd;
use shared::SharedState;
use tray::TrayCommand;
use wm::WindowManager;

fn main() {
    filelog::init();
    install_panic_hook();

    let _instance = match acquire_single_instance() {
        Some(h) => h,
        None => {
            log::warn!("Anchor 已在运行，本次启动退出");
            exit(0);
        }
    };

    log::info!("Anchor desktop-rs 启动（slint）");

    let shared = Arc::new(RwLock::new(SharedState::new()));
    let (gui_cmd_tx, gui_cmd_rx) = mpsc::channel::<GuiCmd>(32);

    // 后台 daemon 线程
    {
        let shared = Arc::clone(&shared);
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_name("anchor-daemon")
                .build()
                .expect("tokio runtime");
            rt.block_on(daemon::run(shared, gui_cmd_rx));
        });
    }

    // 托盘（主线程）
    let tray = match tray::init(Arc::clone(&shared)) {
        Ok(t) => Some(t),
        Err(e) => {
            log::error!("托盘初始化失败（无托盘运行）: {e}");
            None
        }
    };

    // 窗口管理器
    let wm = Rc::new(WindowManager::new(
        Arc::clone(&shared),
        gui_cmd_tx,
        tray,
    ));
    wm.wire_self();

    // 托盘命令直派（wnd_proc 跑在主线程；左右键菜单在 tray 内部弹出）
    let shared_for_tray = Arc::clone(&shared);
    tray::set_command_handler(Rc::new(move |cmd| match cmd {
        TrayCommand::OpenSettings => wm.open_settings(),
        TrayCommand::ReopenIntent => {
            // spawn 后台线程 fetch 当日意图，写入 shared 后由 sync loop 打开弹窗
            let shared = Arc::clone(&shared_for_tray);
            std::thread::spawn(move || {
                let cfg = config::load();
                let url = format!("{}/api/intentions?date=today", cfg.server_url.trim_end_matches('/'));
                let content = match ureq::get(&url).call() {
                    Ok(resp) => {
                        let reader = resp.into_reader();
                        serde_json::from_reader::<_, serde_json::Value>(reader).ok()
                            .and_then(|v| v.get("content")?.as_str().map(|s| s.to_owned()))
                    }
                    Err(e) => {
                        log::warn!("[intent] fetch 今日意图失败: {e}");
                        None
                    }
                };
                if let Ok(mut g) = shared.write() {
                    // 无论有无已写内容都置为 Some（空串 = 空白弹窗），sync loop 据此开窗
                    g.intent_today_prefill = Some(content.unwrap_or_default());
                }
            });
        }
        TrayCommand::Quit => shutdown::request_quit(),
    }));

    log::info!("进入 Slint 事件循环");
    if let Err(e) = slint::run_event_loop_until_quit() {
        log::error!("Slint 事件循环退出: {e}");
    }
}

fn acquire_single_instance() -> Option<HANDLE> {
    unsafe {
        let handle = match CreateMutexW(None, true, w!("Local\\AnchorDesktopMutex")) {
            Ok(h) => h,
            Err(e) => {
                log::warn!("单实例互斥锁创建失败（忽略并继续运行）: {e}");
                return Some(HANDLE::default());
            }
        };
        if GetLastError() == ERROR_ALREADY_EXISTS {
            let _ = CloseHandle(handle);
            return None;
        }
        Some(handle)
    }
}

/// 安装 panic 钩子：Release 模式无控制台，panic 默认丢失，需写入日志文件排障
fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_owned()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "未知 panic".to_owned()
        };
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "未知位置".to_owned());
        log::error!("PANIC: {msg} (位于 {location})");
        default(info);
    }));
}
