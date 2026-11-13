//! UI 辅助：Win32 窗口补丁 + 工作区尺寸

pub mod winpatch;

use windows::Win32::Foundation::RECT;
use windows::Win32::UI::HiDpi::GetDpiForSystem;
use windows::Win32::UI::WindowsAndMessaging::{
    SystemParametersInfoW, SPI_GETWORKAREA, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
};

/// 主显示器 DPI 缩放系数（物理像素 / 逻辑点，96 DPI = 1.0）
pub fn primary_scale() -> f32 {
    unsafe { GetDpiForSystem() as f32 / 96.0 }
}

/// 工作区尺寸（排除任务栏）。物理像素；在 DPI 缩放下与逻辑点有偏差，定位够用。
pub fn work_area() -> Option<(f32, f32)> {
    let mut rect = RECT::default();
    unsafe {
        SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some(&mut rect as *mut _ as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
        .ok()?;
    }
    Some((
        (rect.right - rect.left) as f32,
        (rect.bottom - rect.top) as f32,
    ))
}
