//! 桌面端真自动更新：GitHub Releases 检查 → 下载 → SHA256 校验 → Windows 自替换
//!
//! 自替换经典模式（不引新 crate）：
//! 1. 新 exe 下载到同目录 `Anchor.new.exe`
//! 2. 生成临时 .bat：等待当前进程退出 → 替换 exe → 启动 → 自删
//! 3. spawn bat（独立进程，cmd /c start）→ 当前进程退出
//!
//! 环境变量 `ANCHOR_DESKTOP_NO_UPDATE` 存在时整个模块禁用（开发/打包场景）。

use std::io::Read;
use std::path::{Path, PathBuf};

/// GitHub latest release 端点（四端统一发布于 junugo/Anchor）
const LATEST_API: &str = "https://api.github.com/repos/junugo/Anchor/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/junugo/Anchor/releases";
const USER_AGENT: &str = "Anchor-Desktop";
/// 发布资产命名约定（任务 14 CI 按此产出）：tag = desktop-vX.Y.Z
const ASSET_SUFFIX: &str = "-windows-x64.exe";
const CHECKSUMS_ASSET: &str = "SHA256SUMS";

/// 一次可用的更新信息
#[derive(Clone, Debug)]
pub struct UpdateInfo {
    /// 新版本号（不含 desktop- 前缀，如 1.2.3）
    pub version: String,
    /// exe 资产下载地址
    pub exe_url: String,
    /// SHA256SUMS 资产下载地址
    pub sums_url: String,
}

/// 更新模块是否被禁用（环境变量存在即禁用）
pub fn update_disabled() -> bool {
    std::env::var_os("ANCHOR_DESKTOP_NO_UPDATE").is_some()
}

/// 纯函数：latest 是否比 current 新（semver x.y.z 比较，忽略 pre-release/build 后缀）
pub fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_semver(latest), parse_semver(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

/// 解析 x.y.z（容忍 v 前缀与多余的 .0 段）；失败返回 None
fn parse_semver(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.trim().trim_start_matches('v');
    let core = s.split(['-', '+']).next().unwrap_or(s);
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

/// 从 release JSON 中解析桌面端资产（纯逻辑，供测试）
/// 返回 (version, exe_asset_name, exe_url, sums_url)
pub fn parse_latest_release(json: &serde_json::Value) -> Option<UpdateInfo> {
    let tag = json.get("tag_name")?.as_str()?.trim();
    let version = tag.strip_prefix("desktop-v")?.to_owned();
    let assets = json.get("assets")?.as_array()?;
    let exe_name = format!("anchor-desktop-{version}{ASSET_SUFFIX}");
    let mut exe_url = None;
    let mut sums_url = None;
    for a in assets {
        let name = a.get("name")?.as_str()?;
        let url = a.get("browser_download_url")?.as_str()?.to_owned();
        if name == exe_name {
            exe_url = Some(url);
        } else if name == CHECKSUMS_ASSET {
            sums_url = Some(url);
        }
    }
    Some(UpdateInfo {
        version,
        exe_url: exe_url?,
        sums_url: sums_url?,
    })
}

/// 检查更新：GitHub API 直连（未认证限额 60/h，启动 + 每 24h 一次远低于上限）。
/// 禁用时/网络失败/无新版均返回 None（静默）。
pub fn check_update() -> Option<UpdateInfo> {
    if update_disabled() {
        log::info!("[update] ANCHOR_DESKTOP_NO_UPDATE 已设置，跳过更新检查");
        return None;
    }
    let resp = ureq::get(LATEST_API)
        .set("User-Agent", USER_AGENT)
        .timeout(std::time::Duration::from_secs(5))
        .call();
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            log::warn!("[update] 检查更新失败（忽略）: {e}");
            return None;
        }
    };
    let json: serde_json::Value = match serde_json::from_reader(resp.into_reader()) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[update] 解析 release 信息失败（忽略）: {e}");
            return None;
        }
    };
    let info = match parse_latest_release(&json) {
        Some(i) => i,
        None => {
            log::debug!("[update] 最新 release 无桌面端资产，跳过");
            return None;
        }
    };
    if is_newer(&info.version, env!("CARGO_PKG_VERSION")) {
        log::info!("[update] 发现新版本 {}（当前 {}）", info.version, env!("CARGO_PKG_VERSION"));
        Some(info)
    } else {
        log::debug!("[update] 已是最新版本");
        None
    }
}

/// 从 SHA256SUMS 文本中查找目标文件名的哈希（纯逻辑，供测试）
/// 行格式：`<64位hex>  <文件名>`（两空格分隔）
pub fn find_sha256<'a>(sums: &'a str, file_name: &str) -> Option<&'a str> {
    for line in sums.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?;
        if name == file_name || name.trim_start_matches('*') == file_name {
            return Some(hash);
        }
    }
    None
}

/// 生成 Windows 自替换 bat 内容（纯函数，供测试）
/// 流程：等待旧进程退出（上限 ~60s）→ 替换 exe → 启动新版 → 自删
pub fn build_replace_bat(current_exe: &str, new_exe: &str) -> String {
    format!(
        r#"@echo off
rem Anchor 自动更新脚本：由 Anchor 生成，执行完成后自行删除
rem 等待上限约 60 秒，超时走 :fail 分支
rem 注意：等待循环按【进程名】匹配，若同目录有同名多实例（重复运行 Anchor.exe），
rem       替换会等所有同名进程退出；请避免同名单实例并发运行。
set /a wait_count=0
:wait
tasklist /FI ""IMAGENAME eq {current_name}"" 2>NUL | find /I /N ""{current_name}"" >NUL
if %ERRORLEVEL% == 0 (
    set /a wait_count+=1
    if %wait_count% GTR 60 goto fail
    timeout /t 1 /nobreak >NUL
    goto wait
)
rem 替换 exe
move /y ""{new_exe}"" ""{current_exe}""
if %ERRORLEVEL% NEQ 0 goto fail
rem 启动新版
start """" ""{current_exe}""
rem 自删
del ""%~f0""
exit /b 0
:fail
rem 替换失败/等待超时：保留新文件并提示手动处理
echo 自动替换失败（超时或路径异常），请手动将 {new_exe} 重命名为 {current_name} > ""{bat_fail_log}""
del ""%~f0""
exit /b 1
"#,
        current_name = exe_file_name(current_exe),
        current_exe = current_exe,
        new_exe = new_exe,
        bat_fail_log = fail_log_path(),
    )
}

fn exe_file_name(path: &str) -> &str {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
}

fn fail_log_path() -> String {
    let dir = std::env::temp_dir().to_string_lossy().replace('\\', "\\\\");
    format!("{dir}\\\\anchor-update-fail.txt")
}

/// 当前 exe 所在目录
fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

/// 特殊字符路径预检（纯函数）：bat 中 % 会被变量化、& 会截断命令，含其一即不可自替换
pub fn has_unsafe_path_chars(path: &str) -> bool {
    path.contains(['%', '&'])
}

/// 计算文件 SHA256 hex（sha2 为现有依赖）
fn sha256_hex(path: &Path) -> Result<String, String> {
    use sha2::Digest;
    let mut f = std::fs::File::open(path).map_err(|e| format!("打开文件失败: {e}"))?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("读取文件失败: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 下载 URL 到本地文件（5 分钟超时上限，防止大包卡死）
fn download(url: &str, dest: &Path) -> Result<(), String> {
    let resp = ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .timeout(std::time::Duration::from_secs(300))
        .call()
        .map_err(|e| format!("下载失败: {e}"))?;
    let mut reader = resp.into_reader();
    let mut f = std::fs::File::create(dest).map_err(|e| format!("创建文件失败: {e}"))?;
    std::io::copy(&mut reader, &mut f).map_err(|e| format!("写入失败: {e}"))?;
    Ok(())
}

/// 执行更新：下载 → 校验 → 自替换 → 走正常退出流程（结算最后窗口/尽力上报/清托盘图标）。
/// 调用方（托盘菜单点击）在后台线程调用；成功后进程退出，失败返回 Err 文案。
pub fn perform_update(info: &UpdateInfo) -> Result<(), String> {
    let dir = exe_dir().ok_or_else(|| "无法定位当前 exe 目录".to_owned())?;
    let current_exe = std::env::current_exe().map_err(|e| format!("定位当前 exe 失败: {e}"))?;
    let current_exe = current_exe.to_string_lossy().to_string();

    // 特殊字符路径预检：bat 中 % 会被变量化、& 会截断命令，含这两者直接拒绝自替换
    if has_unsafe_path_chars(&current_exe) {
        return Err("安装路径含特殊字符（% 或 &），无法自动替换".to_owned());
    }
    // 目录可写性预检：不可写时优雅失败，引导手动下载
    if std::fs::metadata(&dir).map(|m| m.permissions().readonly()).unwrap_or(true) {
        return Err("安装目录不可写".to_owned());
    }

    let new_exe = dir.join("Anchor.new.exe");
    let new_exe_str = new_exe.to_string_lossy().to_string();

    log::info!("[update] 开始下载 v{}: {}", info.version, info.exe_url);
    download(&info.exe_url, &new_exe)?;

    // SHA256 校验
    let sums_text = {
        let resp = ureq::get(&info.sums_url)
            .set("User-Agent", USER_AGENT)
            .timeout(std::time::Duration::from_secs(30))
            .call()
            .map_err(|e| format!("下载校验和失败: {e}"))?;
        let mut s = String::new();
        resp.into_reader()
            .read_to_string(&mut s)
            .map_err(|e| format!("读取校验和失败: {e}"))?;
        s
    };
    let file_name = exe_file_name(&new_exe_str).to_owned();
    let expect = find_sha256(&sums_text, &format!("anchor-desktop-{}{ASSET_SUFFIX}", info.version))
        .or_else(|| find_sha256(&sums_text, &file_name))
        .ok_or_else(|| "校验和文件中未找到对应条目".to_owned())?
        .to_lowercase();
    let actual = sha256_hex(&new_exe)?.to_lowercase();
    if actual != expect {
        let _ = std::fs::remove_file(&new_exe);
        return Err(format!("SHA256 校验失败（期望 {expect}，实际 {actual}）"));
    }
    log::info!("[update] 校验通过，准备自替换");

    // 生成并启动替换 bat
    let bat_path = dir.join("anchor-update.bat");
    std::fs::write(&bat_path, build_replace_bat(&current_exe, &new_exe_str))
        .map_err(|e| format!("写入替换脚本失败: {e}"))?;
    let bat_str = bat_path.to_string_lossy().to_string();
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &bat_str])
        .spawn()
        .map_err(|e| format!("启动替换脚本失败: {e}"))?;

    log::info!("[update] 替换脚本已启动，进入正常退出流程");
    // 与托盘「退出」同路径：结算最后窗口焦点、尽力上报、清理托盘图标后退出，
    // 确保更新退出与正常退出行为一致（bat 按进程名轮询等待本进程消失）
    crate::shutdown::request_quit();
}

/// 打开 releases 发布页（更新失败时引导手动下载）
pub fn open_releases_page() {
    let _ = std::process::Command::new("cmd")
        .args(["/c", "start", "", RELEASES_PAGE])
        .spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_newer_semver_compare() {
        assert!(is_newer("1.2.3", "1.2.2"));
        assert!(is_newer("2.0.0", "1.9.9"));
        assert!(is_newer("1.3.0", "1.2.9"));
        assert!(is_newer("v1.0.1", "1.0.0"));
        assert!(is_newer("1.0.0", "0.9"));
        assert!(!is_newer("1.2.2", "1.2.3"));
        assert!(!is_newer("1.2.3", "1.2.3"));
        assert!(!is_newer("1.2.3", "2.0.0"));
        assert!(!is_newer("abc", "1.0.0"));
        assert!(!is_newer("1.0.0", "abc"));
        // pre-release 后缀忽略，仍按核心版本
        assert!(!is_newer("1.2.3-beta", "1.2.3"));
    }

    #[test]
    fn parse_latest_release_finds_desktop_assets() {
        let json = serde_json::json!({
            "tag_name": "desktop-v1.2.3",
            "assets": [
                { "name": "anchor-mobile-1.2.3.apk", "browser_download_url": "https://x/m.apk" },
                { "name": "SHA256SUMS", "browser_download_url": "https://x/sums" },
                { "name": "anchor-desktop-1.2.3-windows-x64.exe", "browser_download_url": "https://x/d.exe" },
            ],
        });
        let info = parse_latest_release(&json).expect("应解析到桌面端资产");
        assert_eq!(info.version, "1.2.3");
        assert_eq!(info.exe_url, "https://x/d.exe");
        assert_eq!(info.sums_url, "https://x/sums");
    }

    #[test]
    fn parse_latest_release_rejects_non_desktop_tag() {
        let json = serde_json::json!({
            "tag_name": "mobile-v1.2.3",
            "assets": [{ "name": "SHA256SUMS", "browser_download_url": "https://x/sums" }],
        });
        assert!(parse_latest_release(&json).is_none());
    }

    #[test]
    fn parse_latest_release_requires_both_assets() {
        let json = serde_json::json!({
            "tag_name": "desktop-v1.2.3",
            "assets": [{ "name": "SHA256SUMS", "browser_download_url": "https://x/sums" }],
        });
        assert!(parse_latest_release(&json).is_none());
    }

    #[test]
    fn find_sha256_parses_sums_line() {
        let sums = "aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233  anchor-desktop-1.2.3-windows-x64.exe\n";
        let h = find_sha256(sums, "anchor-desktop-1.2.3-windows-x64.exe");
        assert_eq!(h, Some("aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233"));
        // *前缀（二进制模式标记）也认
        let sums_star = "aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233 *anchor-desktop-1.2.3-windows-x64.exe\n";
        assert_eq!(
            find_sha256(sums_star, "anchor-desktop-1.2.3-windows-x64.exe"),
            Some("aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233")
        );
        assert_eq!(find_sha256(sums, "other.exe"), None);
        assert_eq!(find_sha256("", "x"), None);
    }

    #[test]
    fn build_replace_bat_waits_moves_starts_and_self_deletes() {
        let bat = build_replace_bat("C:\\App\\Anchor.exe", "C:\\App\\Anchor.new.exe");
        // 等待循环：tasklist 轮询当前 exe 名，且带 60 秒上限
        assert!(bat.contains("tasklist /FI"));
        assert!(bat.contains("Anchor.exe"));
        assert!(bat.contains("wait_count"));
        assert!(bat.contains("GTR 60 goto fail"));
        // 中文注释声明按进程名匹配的同名多实例限制
        assert!(bat.contains("同名多实例"));
        // 替换与启动
        assert!(bat.contains("move /y \"\"C:\\App\\Anchor.new.exe\"\" \"\"C:\\App\\Anchor.exe\"\""));
        assert!(bat.contains("start \"\"\"\" \"\"C:\\App\\Anchor.exe\"\""));
        // 自删与失败分支
        assert!(bat.contains("del \"\"%~f0\"\""));
        assert!(bat.contains("anchor-update-fail.txt"));
        assert!(bat.contains("自动替换失败"));
    }

    #[test]
    fn has_unsafe_path_chars_detects_bat_metacharacters() {
        assert!(has_unsafe_path_chars("C:\\Progs 100%\\Anchor\\Anchor.exe"));
        assert!(has_unsafe_path_chars("C:\\A&B\\Anchor.exe"));
        assert!(!has_unsafe_path_chars("C:\\Program Files\\Anchor\\Anchor.exe"));
        assert!(!has_unsafe_path_chars("C:\\中文目录\\Anchor.exe"));
    }
}
