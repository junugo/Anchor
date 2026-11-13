//! 窗口 Win32 补丁辅助：Slint Window → HWND、点击穿透、置顶、激活、屏幕尺寸

use std::collections::HashMap;
use std::sync::Mutex;

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, GetForegroundWindow, GetSystemMetrics, GetWindowLongPtrW,
    GetWindowThreadProcessId, SetForegroundWindow, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    GWLP_WNDPROC, GWL_EXSTYLE, HWND_TOPMOST, SM_CXSCREEN, SM_CYSCREEN, SWP_FRAMECHANGED,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOW, WM_NCHITTEST, WNDPROC, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

/// 已子类化的 HWND → 原 winit 窗口过程
static OLD_WNDPROCS: Mutex<Option<HashMap<isize, isize>>> = Mutex::new(None);

/// 点击穿透窗口过程：winit 自己处理 WM_NCHITTEST（不交给 DefWindowProc），
/// 因此必须子类化直接返回 HTTRANSPARENT(-1)。
/// 注意：WS_EX_TRANSPARENT 对顶层窗口不仅帮不上忙，还可能让系统跳过本窗口的
/// WM_NCHITTEST 处理，导致子类化失效，因此不再设置该样式。
unsafe extern "system" fn click_through_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_NCHITTEST {
        log::debug!("click_through_proc: WM_NCHITTEST on hwnd={:?}, returning HTTRANSPARENT", hwnd.0);
        return LRESULT(-1);
    }
    let old = OLD_WNDPROCS
        .lock()
        .ok()
        .and_then(|m| m.as_ref()?.get(&(hwnd.0 as isize)).copied());
    match old {
        Some(p) => unsafe {
            CallWindowProcW(
                std::mem::transmute::<isize, WNDPROC>(p),
                hwnd,
                msg,
                wparam,
                lparam,
            )
        },
        None => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// Slint Window → Win32 HWND
pub fn hwnd_of(win: &slint::Window) -> Option<HWND> {
    let handle = win.window_handle();
    let raw = handle.window_handle().ok()?;
    if let RawWindowHandle::Win32(h) = raw.as_raw() {
        Some(HWND(h.hwnd.get() as *mut _))
    } else {
        None
    }
}

/// 点击穿透 + 无激活 + 工具窗口 + 置顶（pill 浮窗用）
pub unsafe fn patch_click_through(hwnd: HWND) {
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    if ex == 0 {
        let err = windows::core::Error::from_win32();
        log::warn!("patch_click_through: 无法读取窗口扩展样式: {err}");
    }
    let new_ex = ex
        // 去掉 WS_EX_TRANSPARENT：顶层窗口的穿透应通过 WM_NCHITTEST 返回
        // HTTRANSPARENT 实现；WS_EX_TRANSPARENT 主要针对子窗口，顶层使用
        // 反而可能让系统跳过 WM_NCHITTEST，导致子类化失效。
        & !(WS_EX_TRANSPARENT.0 as isize)
        | WS_EX_NOACTIVATE.0 as isize
        | WS_EX_TOOLWINDOW.0 as isize;
    let prev = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex);
    if prev == 0 {
        let err = windows::core::Error::from_win32();
        log::warn!("patch_click_through: 无法设置窗口扩展样式: {err}");
    } else {
        log::debug!("patch_click_through: exstyle 0x{:x} -> 0x{:x}", ex, new_ex);
    }
    // SWP_FRAMECHANGED 刷新 exstyle 缓存，TOOLWINDOW/NOACTIVATE 才会生效（任务栏隐藏）
    let _ = SetWindowPos(
        hwnd,
        Some(HWND_TOPMOST),
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED | SWP_NOACTIVATE,
    );
    // 子类化拦截 WM_NCHITTEST：winit 默认返回 HTCLIENT，必须由我们覆盖。
    // 用 hwnd 作为 key 记录是否已子类化，避免反复 SetWindowLongPtr 导致旧过程链断裂。
    let proc_addr = click_through_proc as *const () as usize as isize;
    if GetWindowLongPtrW(hwnd, GWLP_WNDPROC) != proc_addr {
        let old = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, proc_addr);
        if old != 0 {
            if let Ok(mut guard) = OLD_WNDPROCS.lock() {
                guard
                    .get_or_insert_with(HashMap::new)
                    .insert(hwnd.0 as isize, old);
            }
            log::info!("patch_click_through: hwnd={:?} 已子类化，旧 WNDPROC=0x{:x}", hwnd.0, old);
        } else {
            let err = windows::core::Error::from_win32();
            log::warn!("patch_click_through: 子类化失败: {err}");
        }
    } else {
        log::debug!("patch_click_through: hwnd={:?} 已处于子类化状态，跳过", hwnd.0);
    }
}

/// 强化置顶（curfew 用）
pub unsafe fn patch_topmost(hwnd: HWND) {
    let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
}

/// 强制激活窗口（程序化 show 的窗口默认不是前台窗口，IME 不挂接）
pub fn activate(hwnd: HWND) {
    if hwnd.0.is_null() {
        return;
    }
    unsafe {
        let foreground = GetForegroundWindow();
        let fg_tid = GetWindowThreadProcessId(foreground, None);
        let my_tid = GetCurrentThreadId();
        if fg_tid != my_tid {
            let _ = AttachThreadInput(my_tid, fg_tid, true);
        }
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = SetForegroundWindow(hwnd);
        if fg_tid != my_tid {
            let _ = AttachThreadInput(my_tid, fg_tid, false);
        }
    }
}

/// 主显示器分辨率（物理像素）
pub fn screen_size() -> (i32, i32) {
    unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) }
}
