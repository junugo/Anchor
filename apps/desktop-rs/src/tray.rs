//! 自研 Win32 托盘：图标、动态菜单、气泡通知（Shell_NotifyIconW 全家桶）
//!
//! 为什么不用 tray-icon crate：它不暴露气泡通知（NIF_INFO）能力，
//! 自研可同时掌控图标/菜单/气泡，零额外依赖。
//!
//! 结构：隐藏消息窗口（与 Slint 事件循环同在主线程，由其消息泵顺带 Dispatch）
//! - 左键 → TrayCommand::LeftClick
//! - 右键 → WndProc 内直接构建并弹出菜单（TPM_RETURNCMD），选中项转为命令
//! 命令通过 thread_local 回调直接派发（wnd_proc 本就跑在主线程）

use std::cell::RefCell;
use std::ffi::c_void;
use std::rc::Rc;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

use windows::core::{w, BOOL, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateBitmap, CreateDIBSection, DeleteObject, GetDC, ReleaseDC, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC,
};
use windows::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_TIP, NIIF_NOSOUND, NIM_ADD,
    NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreateIconIndirect, CreatePopupMenu, CreateWindowExW, DefWindowProcW,
    DestroyIcon, DestroyMenu, GetCursorPos, RegisterClassExW, SetForegroundWindow,
    TrackPopupMenu, CW_USEDEFAULT, HMENU, ICONINFO, MF_GRAYED, MF_SEPARATOR, MF_STRING,
    TPM_NONOTIFY, TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_APP, WM_LBUTTONUP, WM_RBUTTONUP,
    WNDCLASSEXW, WS_EX_TOOLWINDOW,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;

use crate::shared::{SharedState, SunsetPhase};

const WM_TRAYICON: u32 = WM_APP + 1;
const TRAY_UID: u32 = 1;

const ID_SETTINGS: usize = 1003;
const ID_QUIT: usize = 1004;
const ID_INTENT: usize = 1005;

// 气球通知被点击（Shell_NotifyIconW 回调 lparam 低位）
const NIN_BALLOONUSERACTION: u32 = 0x0405;

const WND_CLASS: PCWSTR = w!("AnchorTrayMsgWnd");

static TRAY_STATE: OnceLock<Arc<RwLock<SharedState>>> = OnceLock::new();
static TRAY_HWND: AtomicIsize = AtomicIsize::new(0);

thread_local! {
    static CMD_HANDLER: RefCell<Option<Rc<dyn Fn(TrayCommand)>>> = const { RefCell::new(None) };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayCommand {
    OpenSettings,
    Quit,
    /// 重开睡前意图弹窗（托盘菜单 / 气球点击）
    ReopenIntent,
}

/// 注册命令处理器（主线程调用；wnd_proc 跑在主线程，直接同步派发）
pub fn set_command_handler(handler: Rc<dyn Fn(TrayCommand)>) {
    CMD_HANDLER.with(|c| *c.borrow_mut() = Some(handler));
}

pub struct Tray {
    hwnd: HWND,
    icon: windows::Win32::UI::WindowsAndMessaging::HICON,
    phase: SunsetPhase,
    user_state: Option<String>,
}

/// 在主线程初始化托盘。
pub fn init(shared: Arc<RwLock<SharedState>>) -> windows::core::Result<Tray> {
    let _ = TRAY_STATE.set(shared);

    unsafe {
        let hinstance = GetModuleHandleW(None)?;
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(wnd_proc),
            hInstance: hinstance.into(),
            lpszClassName: WND_CLASS,
            ..Default::default()
        };
        let atom = RegisterClassExW(&wc);
        if atom == 0 {
            log::error!("注册托盘消息窗口类失败");
        }

        let hwnd = CreateWindowExW(
            WS_EX_TOOLWINDOW,
            WND_CLASS,
            w!("AnchorTray"),
            Default::default(),
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            None,
            None,
            Some(hinstance.into()),
            None,
        )?;

        let icon = gen_hicon(phase_color(SunsetPhase::Off), None);
        add_icon(hwnd, icon, "Anchor")?;
        TRAY_HWND.store(hwnd.0 as isize, Ordering::Relaxed);
        log::info!("托盘已创建");

        Ok(Tray {
            hwnd,
            icon,
            phase: SunsetPhase::Off,
            user_state: None,
        })
    }
}

impl Tray {
    /// 阶段变化时更新图标
    pub fn set_phase(&mut self, phase: SunsetPhase) {
        if phase == self.phase {
            return;
        }
        self.phase = phase;
        self.refresh_icon();
    }

    /// 用户状态变化时更新图标（右上角状态色点）
    pub fn set_state(&mut self, user_state: Option<&str>) {
        let next = user_state.map(|s| s.to_owned());
        if next == self.user_state {
            return;
        }
        self.user_state = next;
        self.refresh_icon();
    }

    /// 按当前相位 + 状态重绘图标
    fn refresh_icon(&mut self) {
        unsafe {
            let new_icon = gen_hicon(phase_color(self.phase), state_color(self.user_state.as_deref()));
            let mut nid = base_nid(self.hwnd);
            nid.uFlags = NIF_ICON;
            nid.hIcon = new_icon;
            let _ = Shell_NotifyIconW(NIM_MODIFY, &nid);
            let old = std::mem::replace(&mut self.icon, new_icon);
            let _ = DestroyIcon(old);
        }
    }

    pub fn set_tooltip(&self, text: &str) {
        unsafe {
            let mut nid = base_nid(self.hwnd);
            nid.uFlags = NIF_TIP;
            write_wide(&mut nid.szTip, text);
            let _ = Shell_NotifyIconW(NIM_MODIFY, &nid);
        }
    }

    /// 气泡通知（Win10 自动转为 Toast）
    pub fn balloon(&self, title: &str, body: &str, silent: bool) {
        unsafe {
            let mut nid = base_nid(self.hwnd);
            nid.uFlags = NIF_INFO;
            write_wide(&mut nid.szInfoTitle, title);
            write_wide(&mut nid.szInfo, body);
            nid.dwInfoFlags = if silent { NIIF_NOSOUND } else { Default::default() };
            let _ = Shell_NotifyIconW(NIM_MODIFY, &nid);
        }
    }
}

/// 退出时移除托盘图标
pub fn remove_icon() {
    let hwnd = HWND(TRAY_HWND.load(Ordering::Relaxed) as *mut c_void);
    if hwnd.0.is_null() {
        return;
    }
    unsafe {
        let nid = base_nid(hwnd);
        let _ = Shell_NotifyIconW(NIM_DELETE, &nid);
    }
}

/// 消费 SharedState 里积压的通知
pub fn drain_notifications(tray: &Tray, shared: &mut SharedState, enabled: bool) {
    if shared.pending_notifications.is_empty() {
        return;
    }
    if !enabled {
        shared.pending_notifications.clear();
        return;
    }
    for n in shared.pending_notifications.drain(..) {
        tray.balloon(&n.title, &n.body, n.silent);
    }
}

fn base_nid(hwnd: HWND) -> NOTIFYICONDATAW {
    NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: hwnd,
        uID: TRAY_UID,
        uCallbackMessage: WM_TRAYICON,
        ..Default::default()
    }
}

fn add_icon(hwnd: HWND, icon: windows::Win32::UI::WindowsAndMessaging::HICON, tip: &str) -> windows::core::Result<()> {
    let mut nid = base_nid(hwnd);
    nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    nid.hIcon = icon;
    write_wide(&mut nid.szTip, tip);
    unsafe {
        Shell_NotifyIconW(NIM_ADD, &nid).ok()?;
    }
    Ok(())
}

fn write_wide(dst: &mut [u16], text: &str) {
    let wide: Vec<u16> = text.encode_utf16().collect();
    let n = wide.len().min(dst.len() - 1);
    dst[..n].copy_from_slice(&wide[..n]);
    dst[n] = 0;
}

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_TRAYICON {
        let mouse = lparam.0 as u32 & 0xFFFF;
        // 气球点击：重开睡前意图弹窗（无活跃重开入口时 wm 侧空操作）
        if mouse == NIN_BALLOONUSERACTION {
            send_cmd(TrayCommand::ReopenIntent);
            return LRESULT(0);
        }
        // 左右键均弹出菜单（Steam 式：菜单随鼠标位置出现）
        if mouse == WM_LBUTTONUP || mouse == WM_RBUTTONUP {
            show_context_menu(hwnd);
        }
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn send_cmd(cmd: TrayCommand) {
    CMD_HANDLER.with(|c| {
        if let Some(h) = c.borrow().as_ref() {
            h(cmd);
        }
    });
}

/// 右键菜单：即时读取共享状态构建
unsafe fn show_context_menu(hwnd: HWND) {
    let snapshot = TRAY_STATE.get().and_then(|s| s.read().ok().map(|g| {
        (
            g.connected,
            g.config_error.clone(),
            g.user_state.clone(),
            g.sunset_phase,
            g.target_bedtime_minutes,
            g.paired,
        )
    }));

    let menu = match CreatePopupMenu() {
        Ok(m) => m,
        Err(_) => return,
    };

    let status_line = match &snapshot {
        Some((connected, config_error, user_state, _, _, paired)) => {
            if let Some(err) = config_error {
                format!("配置错误 · {err}")
            } else if !*paired {
                "未配对 · 请在设置中配对".to_owned()
            } else {
                let conn = if *connected { "已连接" } else { "未连接" };
                let state = user_state
                    .as_deref()
                    .map(state_label)
                    .unwrap_or("未知");
                format!("{state} · {conn}")
            }
        }
        None => "Anchor 运行中".to_owned(),
    };
    append_text(menu, &format!("Anchor · {status_line}"), false);

    if let Some((_, _, _, phase, target, _)) = &snapshot {
        if *phase != SunsetPhase::Off {
            let remaining = remaining_minutes(*target);
            append_text(menu, &format!("距就寝 {remaining} 分钟 · {}", phase.label()), false);
        }
    }

    // 睡前意图：常驻菜单入口，点击后 fetch 当日意图并打开编辑弹窗
    append_item(menu, ID_INTENT, "写睡前意图");

    let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
    append_item(menu, ID_SETTINGS, "设置");
    let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
    append_item(menu, ID_QUIT, "退出");

    let mut pt = POINT::default();
    let _ = GetCursorPos(&mut pt);
    // TrackPopupMenu 需要前台窗口，否则点击菜单外不收起
    let _ = SetForegroundWindow(hwnd);
    let cmd = TrackPopupMenu(
        menu,
        TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON,
        pt.x,
        pt.y,
        Some(0),
        hwnd,
        None,
    );
    let _ = DestroyMenu(menu);

    match cmd.0 as usize {
        ID_SETTINGS => send_cmd(TrayCommand::OpenSettings),
        ID_INTENT => send_cmd(TrayCommand::ReopenIntent),
        ID_QUIT => send_cmd(TrayCommand::Quit),
        _ => {}
    }
}

fn append_text(menu: HMENU, text: &str, enabled: bool) {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let flags = if enabled { MF_STRING } else { MF_STRING | MF_GRAYED };
    let _ = unsafe { AppendMenuW(menu, flags, 0, PCWSTR(wide.as_ptr())) };
}

fn append_item(menu: HMENU, id: usize, text: &str) {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let _ = unsafe { AppendMenuW(menu, MF_STRING, id, PCWSTR(wide.as_ptr())) };
}

pub fn state_label(state: &str) -> &'static str {
    match state {
        "working" => "专注工作",
        "entertaining" => "娱乐中",
        "dissociating" => "解离中",
        "resting" => "休息中",
        "sleeping" => "睡眠中",
        "transitioning" => "过渡中",
        "away" => "在校",
        _ => "未知",
    }
}

/// 距目标就寝时间的剩余分钟。
/// live 倒计时的语义是「到点即 0」：归零后继续走说明宵禁已到，
/// 不做跨天回绕（回绕会显示「距就寝还有 1439 分钟」这类诡异文案）。
pub fn remaining_minutes(target: i64) -> i64 {
    let st = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    let now = st.wHour as i64 * 60 + st.wMinute as i64;
    let diff = target - now;
    if diff < 0 {
        0
    } else {
        diff
    }
}

fn phase_color(phase: SunsetPhase) -> Option<[u8; 3]> {
    match phase {
        SunsetPhase::T60 => Some([0xc0, 0x62, 0x2a]), // 橙褐
        SunsetPhase::T30 => Some([0xcf, 0x22, 0x2e]), // 红
        SunsetPhase::T15 => Some([0xcf, 0x22, 0x2e]), // 红（与 T30 同桶，临近就寝）
        _ => None,                                    // Off：纯锚图标，无相位点
    }
}

/// 状态 → 图标状态色点（右上角，浅色 token 色值）。
/// 映射单一来源：packages/utils/src/state.ts `STATE_COLOR_TOKENS`（手动同步，勿改）：
/// working=passive / resting=soft / entertaining=hard / dissociating=curfew / sleeping=sleep / away=away / transitioning=无点
fn state_color(state: Option<&str>) -> Option<[u8; 3]> {
    match state? {
        "working" => Some([0x22, 0x86, 0x3a]), // #22863a 绿
        "resting" => Some([0xb0, 0x88, 0x00]), // #b08800 黄
        "entertaining" => Some([0xc0, 0x62, 0x2a]), // #c0622a 橙
        "dissociating" => Some([0xcf, 0x22, 0x2e]), // #cf222e 红
        "sleeping" => Some([0x1e, 0x3a, 0x8a]), // #1e3a8a 深蓝
        "away" => Some([0x6e, 0x76, 0x81]), // #6e7681 灰蓝
        _ => None, // transitioning / 未知：无点
    }
}

/// 统一 Anchor 图标的 32x32 RGBA 底图（scripts/rasterize-icon.mjs 生成）
static BASE_ICON: &[u8] = include_bytes!("../assets/tray-icon.rgba");

/// 底图 + 左下角相位色点（Off 阶段无点）+ 右上角状态色点（transitioning/未知无点）
fn gen_hicon(accent: Option<[u8; 3]>, state: Option<[u8; 3]>) -> windows::Win32::UI::WindowsAndMessaging::HICON {
    const SIZE: usize = 32;
    let mut rgba = BASE_ICON.to_vec();

    // 绘制圆点：圆心 + 半径
    let mut paint = |center: (f32, f32), color: [u8; 3]| {
        let r = 5.0f32;
        for y in 0..SIZE {
            for x in 0..SIZE {
                let dx = x as f32 + 0.5 - center.0;
                let dy = y as f32 + 0.5 - center.1;
                if dx * dx + dy * dy <= r * r {
                    let i = (y * SIZE + x) * 4;
                    rgba[i] = color[0];
                    rgba[i + 1] = color[1];
                    rgba[i + 2] = color[2];
                    rgba[i + 3] = 0xff;
                }
            }
        }
    };

    if let Some(accent) = accent {
        paint((8.0, 24.0), accent); // 左下：相位点
    }
    if let Some(state) = state {
        paint((24.0, 8.0), state); // 右上：状态点
    }

    unsafe { rgba_to_hicon(&rgba, SIZE as u32) }
}

/// RGBA 像素 → HICON（BGRA 预乘 + DIB + CreateIconIndirect）
unsafe fn rgba_to_hicon(rgba: &[u8], size: u32) -> windows::Win32::UI::WindowsAndMessaging::HICON {
    let hdc: HDC = GetDC(None);

    let bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: size as i32,
            biHeight: -(size as i32), // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };

    let mut bits: *mut c_void = std::ptr::null_mut();
    let hbmp: HBITMAP = CreateDIBSection(Some(hdc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
        .expect("CreateDIBSection");

    let count = (size * size * 4) as usize;
    let dst = std::slice::from_raw_parts_mut(bits as *mut u8, count);
    for (i, px) in rgba.chunks_exact(4).enumerate() {
        let (r, g, b, a) = (px[0] as u32, px[1] as u32, px[2] as u32, px[3] as u32);
        dst[i * 4] = ((b * a) / 255) as u8;
        dst[i * 4 + 1] = ((g * a) / 255) as u8;
        dst[i * 4 + 2] = ((r * a) / 255) as u8;
        dst[i * 4 + 3] = a as u8;
    }

    let mask = CreateBitmap(size as i32, size as i32, 1, 1, None);
    let ii = ICONINFO {
        fIcon: BOOL(1),
        xHotspot: 0,
        yHotspot: 0,
        hbmMask: mask,
        hbmColor: hbmp,
    };
    let hicon = CreateIconIndirect(&ii).expect("CreateIconIndirect");

    let _ = DeleteObject(hbmp.into());
    let _ = DeleteObject(mask.into());
    ReleaseDC(None, hdc);
    hicon
}
