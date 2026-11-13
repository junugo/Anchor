//! 开机自启：HKCU\Software\Microsoft\Windows\CurrentVersion\Run

use windows::core::w;
use windows::Win32::System::Registry::{
    RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_SZ, REG_VALUE_TYPE,
};

const VALUE_NAME: windows::core::PCWSTR = w!("AnchorDesktop");

pub fn set_autostart(enable: bool) -> windows::core::Result<()> {
    unsafe {
        let mut key = HKEY::default();
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run"),
            Some(0),
            KEY_SET_VALUE,
            &mut key,
        )
        .ok()?;
        let result = if enable {
            let exe = std::env::current_exe().unwrap_or_default();
            let exe_str = exe.to_string_lossy().to_string();
            let wide: Vec<u16> = exe_str.encode_utf16().chain(std::iter::once(0)).collect();
            RegSetValueExW(
                key,
                VALUE_NAME,
                Some(0),
                REG_SZ,
                Some(std::slice::from_raw_parts(
                    wide.as_ptr() as *const u8,
                    wide.len() * 2,
                )),
            )
        } else {
            RegDeleteValueW(key, VALUE_NAME)
        };
        let _ = RegCloseKey(key);
        if let Err(e) = result.ok() {
            log::error!("设置自启失败: {e}");
            return Err(e);
        }
        Ok(())
    }
}

pub fn autostart_enabled() -> bool {
    unsafe {
        let mut key = HKEY::default();
        if RegOpenKeyExW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run"),
            Some(0),
            KEY_QUERY_VALUE,
            &mut key,
        )
        .is_err()
        {
            return false;
        }
        let mut ty = REG_VALUE_TYPE::default();
        let mut size = 0u32;
        let r = RegQueryValueExW(
            key,
            VALUE_NAME,
            None,
            Some(&mut ty),
            None,
            Some(&mut size),
        );
        let _ = RegCloseKey(key);
        r.is_ok()
    }
}
