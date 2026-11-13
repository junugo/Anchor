//! 进程图标提取与上传：exe → 32px HICON → RGBA → PNG base64 → POST /api/processes/classify
//!
//! 与 Android / Chrome 端同一约定：纯 base64 PNG（无 data: 前缀），
//! 仅在本地缓存未命中时上传一次；提取失败（无图标 exe）也会落缓存避免反复尝试。

use std::ffi::c_void;
use std::time::Duration;

use base64::Engine as _;
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Graphics::Gdi::{
    DeleteObject, GetDIBits, GetObjectW, GetDC, ReleaseDC, BITMAP, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
};
use windows::Win32::UI::Shell::{ExtractIconExW, SHDefExtractIconW};
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, GetIconInfo, HICON, ICONINFO,
};

/// 见到新进程时调用：缓存未命中 → 提取图标 → 上传（尽力而为，失败留待下次运行重试）
pub fn ensure_uploaded(process: &str, exe_path: &str) {
    let Some(conn) = open_cache() else { return };
    if cache_contains(&conn, process) {
        return;
    }

    let Some(b64) = extract_icon_base64(exe_path) else {
        cache_mark(&conn, process);
        return;
    };

    let server_url = crate::config::load().server_url;
    let url = format!("{}/api/processes/classify", server_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "process_name": process,
        "display_name": process,
        "icon_base64": b64,
    })
    .to_string();

    match ureq::post(&url)
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(5))
        .send_string(&body)
    {
        Ok(_) => {
            cache_mark(&conn, process);
            log::info!("[icon] 已上传进程图标: {process}");
        }
        Err(ureq::Error::Status(400, _)) => {
            // 服务器忽略的系统噪音进程：永久标记，不再尝试
            cache_mark(&conn, process);
        }
        Err(e) => {
            log::warn!("[icon] 图标上传失败 {process}: {e}");
        }
    }
}

/// exe → 32px 图标 → PNG base64（无 data: 前缀）；任何一步失败返回 None
pub fn extract_icon_base64(exe_path: &str) -> Option<String> {
    unsafe {
        let hpath = HSTRING::from(exe_path);
        let mut large = HICON::default();
        let mut small = HICON::default();
        let count = ExtractIconExW(
            PCWSTR(hpath.as_ptr()),
            0,
            Some(&mut large),
            Some(&mut small),
            1,
        );

        let mut hicon = if count > 0 { large } else { HICON::default() };
        let mut fallback = HICON::default();
        if hicon.is_invalid() {
            // exe 无图标资源：取 shell 对该文件类型的默认图标
            if SHDefExtractIconW(PCWSTR(hpath.as_ptr()), 0, 0, Some(&mut fallback), None, 32).is_ok() {
                hicon = fallback;
            }
        }

        let pixels = if hicon.is_invalid() {
            None
        } else {
            hicon_to_rgba(hicon)
        };

        if !large.is_invalid() {
            let _ = DestroyIcon(large);
        }
        if !small.is_invalid() {
            let _ = DestroyIcon(small);
        }
        if !fallback.is_invalid() && fallback != large {
            let _ = DestroyIcon(fallback);
        }

        let (w, h, rgba) = pixels?;
        let png = encode_png(w, h, &rgba)?;
        Some(base64::engine::general_purpose::STANDARD.encode(png))
    }
}

/// HICON → (宽, 高, RGBA 像素)
unsafe fn hicon_to_rgba(hicon: HICON) -> Option<(u32, u32, Vec<u8>)> {
    let mut ii = ICONINFO::default();
    GetIconInfo(hicon, &mut ii).ok()?;

    let result = (|| {
        if ii.hbmColor.is_invalid() {
            return None;
        }
        let mut bm = BITMAP::default();
        let got = GetObjectW(
            ii.hbmColor.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut _ as *mut c_void),
        );
        if got == 0 {
            return None;
        }
        let (w, h) = (bm.bmWidth as u32, bm.bmHeight as u32);
        if w == 0 || h == 0 || w > 256 || h > 256 {
            return None;
        }

        let hdc = GetDC(None);
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w as i32,
                biHeight: -(h as i32), // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bgra = vec![0u8; (w * h * 4) as usize];
        let lines = GetDIBits(
            hdc,
            ii.hbmColor,
            0,
            h,
            Some(bgra.as_mut_ptr() as *mut c_void),
            &mut bmi,
            DIB_RGB_COLORS,
        );
        ReleaseDC(None, hdc);
        if lines == 0 {
            return None;
        }

        // BGRA → RGBA；部分图标位图 alpha 通道全 0（颜色有效），此时按不透明处理
        let has_alpha = bgra.chunks_exact(4).any(|px| px[3] != 0);
        let mut rgba = Vec::with_capacity(bgra.len());
        for px in bgra.chunks_exact(4) {
            rgba.push(px[2]);
            rgba.push(px[1]);
            rgba.push(px[0]);
            rgba.push(if has_alpha { px[3] } else { 0xff });
        }
        Some((w, h, rgba))
    })();

    if !ii.hbmColor.is_invalid() {
        let _ = DeleteObject(ii.hbmColor.into());
    }
    if !ii.hbmMask.is_invalid() {
        let _ = DeleteObject(ii.hbmMask.into());
    }
    result
}

fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let mut buf = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut buf, w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(buf)
}

// ─── 已上传缓存（与离线队列同一个 SQLite 文件，独立连接） ─────────────────

fn open_cache() -> Option<rusqlite::Connection> {
    let dir = crate::config::data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let conn = rusqlite::Connection::open(dir.join("anchor-offline.db")).ok()?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS icon_uploaded (
            process     TEXT PRIMARY KEY,
            uploaded_at INTEGER NOT NULL
        )",
    )
    .ok()?;
    Some(conn)
}

fn cache_contains(conn: &rusqlite::Connection, process: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM icon_uploaded WHERE process = ?1",
        [process],
        |_| Ok(()),
    )
    .is_ok()
}

fn cache_mark(conn: &rusqlite::Connection, process: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    if let Err(e) = conn.execute(
        "INSERT OR REPLACE INTO icon_uploaded (process, uploaded_at) VALUES (?1, ?2)",
        rusqlite::params![process, now],
    ) {
        log::warn!("[icon] 缓存写入失败: {e}");
    }
}
