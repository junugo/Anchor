//! 前台窗口追踪：复刻旧版 index.ts 的 window_focus 采集语义
//!
//! - 5s tick（对齐 Android 轮询间隔）；进程切换时结算上一窗口的真实停留时长
//! - window_active：进入新窗口立即上报 + 驻留期间每 45s 心跳，
//!   让服务器实时掌握当前前台窗口（工作信号新鲜度 ≤45s，覆盖 60s 判定窗口）
//! - 空闲判定（增强版）：
//!   1. 连续 60s 无前台窗口（旧版为 2 tick × 30s，提频后改为时间制保持语义）
//!   2. 前台为锁屏界面 LockApp.exe（新增）
//!   3. 距上次键鼠输入超过 IDLE_INPUT_THRESHOLD_MS（新增，GetLastInputInfo）
//! - 退出前 flush 结算

use std::time::{Duration, Instant};

use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
};

pub const COLLECT_INTERVAL: Duration = Duration::from_secs(5);
const NO_FOREGROUND_IDLE: Duration = Duration::from_secs(60);
const ACTIVE_HEARTBEAT: Duration = Duration::from_secs(45);
const IDLE_INPUT_THRESHOLD_MS: u64 = 300_000; // 5 分钟无键鼠输入视为空闲
const LOCKAPP: &str = "LockApp.exe";

pub struct WindowSample {
    pub process: String,
    pub title: String,
    /// exe 完整路径（进程图标提取用；打不开进程句柄时为空串）
    pub path: String,
}

/// 追踪循环产出的事件
pub enum TrackerEvent {
    /// 需要上报服务器的 ingest 事件
    Ingest {
        event_type: &'static str,
        payload: serde_json::Value,
    },
    /// 见到一个进程（daemon 侧用于进程图标上传，不上报服务器）
    ProcessSeen { process: String, path: String },
}

/// 采样当前前台窗口（进程名 + 标题 + exe 路径）；无前台窗口返回 None
pub fn sample_foreground() -> Option<WindowSample> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }

        let path = process_path(pid).unwrap_or_default();
        let process = path
            .rsplit('\\')
            .next()
            .unwrap_or(path.as_str())
            .to_owned();

        let mut buf = [0u16; 512];
        let n = GetWindowTextW(hwnd, &mut buf);
        let title = if n > 0 {
            String::from_utf16_lossy(&buf[..n as usize])
        } else {
            String::new()
        };

        Some(WindowSample { process, title, path })
    }
}

/// 距上次键鼠输入的毫秒数（GetLastInputInfo）
pub fn idle_millis() -> u64 {
    unsafe {
        let mut lii = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut lii).as_bool() {
            GetTickCount().wrapping_sub(lii.dwTime) as u64
        } else {
            0
        }
    }
}

fn process_path(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 260];
        let mut len = buf.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(handle);
        result.ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

pub struct FocusTracker {
    last_focus_at: Instant,
    last_process: String,
    last_title: String,
    /// 首次发现无前台窗口的时刻（持续 60s 才判空闲）
    no_foreground_since: Option<Instant>,
    /// 上次发出 window_active 的时刻（进入新窗口或心跳）
    last_active_at: Instant,
}

impl FocusTracker {
    pub fn new() -> Self {
        Self {
            last_focus_at: Instant::now(),
            last_process: String::new(),
            last_title: String::new(),
            no_foreground_since: None,
            last_active_at: Instant::now(),
        }
    }

    /// 每个 tick 调用；返回本 tick 产出的事件（结算 / window_active / 新进程）
    pub fn tick(&mut self) -> Vec<TrackerEvent> {
        let now = Instant::now();
        let idle_by_input = idle_millis() > IDLE_INPUT_THRESHOLD_MS;

        match sample_foreground() {
            None => {
                let since = self.no_foreground_since.get_or_insert(now);
                if now.duration_since(*since) >= NO_FOREGROUND_IDLE && !self.last_process.is_empty()
                {
                    return vec![TrackerEvent::Ingest {
                        event_type: "window_focus",
                        payload: self.settle(now, true),
                    }];
                }
                Vec::new()
            }
            Some(sample) if sample.process == LOCKAPP || idle_by_input => {
                // 锁屏 / 长时间无输入 → 结算上一窗口为空闲（心跳随之停止）
                self.no_foreground_since = None;
                if !self.last_process.is_empty() {
                    vec![TrackerEvent::Ingest {
                        event_type: "window_focus",
                        payload: self.settle(now, true),
                    }]
                } else {
                    Vec::new()
                }
            }
            Some(sample) => {
                self.no_foreground_since = None;
                if sample.process != self.last_process {
                    let mut events = Vec::new();
                    if !self.last_process.is_empty() {
                        events.push(TrackerEvent::Ingest {
                            event_type: "window_focus",
                            payload: self.make_payload(now, false),
                        });
                    }
                    self.last_focus_at = now;
                    self.last_process = sample.process.clone();
                    self.last_title = sample.title.clone();
                    self.last_active_at = now;
                    events.push(TrackerEvent::Ingest {
                        event_type: "window_active",
                        payload: serde_json::json!({
                            "process": sample.process,
                            "window_title": sample.title,
                        }),
                    });
                    if !sample.path.is_empty() {
                        events.push(TrackerEvent::ProcessSeen {
                            process: sample.process,
                            path: sample.path,
                        });
                    }
                    events
                } else {
                    // 同一窗口驻留：标题随 tick 刷新（浏览器换 tab 等场景），45s 心跳保活
                    self.last_title = sample.title;
                    if now.duration_since(self.last_active_at) >= ACTIVE_HEARTBEAT {
                        self.last_active_at = now;
                        return vec![TrackerEvent::Ingest {
                            event_type: "window_active",
                            payload: serde_json::json!({
                                "process": self.last_process,
                                "window_title": self.last_title,
                            }),
                        }];
                    }
                    Vec::new()
                }
            }
        }
    }

    /// 退出前结算当前窗口
    pub fn flush(&mut self) -> Option<serde_json::Value> {
        if self.last_process.is_empty() {
            return None;
        }
        Some(self.settle(Instant::now(), false))
    }

    fn settle(&mut self, now: Instant, is_idle: bool) -> serde_json::Value {
        let payload = self.make_payload(now, is_idle);
        self.last_process.clear();
        self.last_title.clear();
        self.last_focus_at = now;
        payload
    }

    fn make_payload(&self, now: Instant, is_idle: bool) -> serde_json::Value {
        serde_json::json!({
            "process": self.last_process,
            "window_title": self.last_title,
            "duration_ms": now.duration_since(self.last_focus_at).as_millis() as u64,
            "is_idle": is_idle,
        })
    }
}
