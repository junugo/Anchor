//! 桌面端自身设置（不含服务器决策项），持久化到 %APPDATA%/Anchor/config.toml

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 默认服务器地址：本地开发实例。生产部署请在设置中改为自己的服务器地址
pub const DEFAULT_SERVER_URL: &str = "http://localhost:4000";

/// pill 倒计时浮窗位置
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PillPosition {
    TopLeft,
    TopCenter,
    TopRight,
    BottomLeft,
    #[default]
    BottomRight,
}

impl PillPosition {
    /// 与设置 UI 的选项索引互转（左上/中上/右上/左下/右下）
    pub fn from_index(i: i32) -> Self {
        match i {
            0 => Self::TopLeft,
            1 => Self::TopCenter,
            2 => Self::TopRight,
            3 => Self::BottomLeft,
            _ => Self::BottomRight,
        }
    }

    pub fn to_index(self) -> i32 {
        match self {
            Self::TopLeft => 0,
            Self::TopCenter => 1,
            Self::TopRight => 2,
            Self::BottomLeft => 3,
            Self::BottomRight => 4,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Config {
    /// 配置版本，用于旧安装实例默认地址/密钥迁移
    #[serde(default)]
    pub config_version: u32,
    /// 服务器 HTTP 地址，如 http://localhost:4000
    pub server_url: String,
    /// 开机自启
    pub autostart: bool,
    /// 窗口焦点追踪
    pub tracking_enabled: bool,
    /// 桌面通知
    pub notifications_enabled: bool,
    /// pill 倒计时浮窗位置
    #[serde(default)]
    pub pill_position: PillPosition,
    /// 上行行为数据加密密钥：配对成功时由服务器下发覆盖；手动配置仅用于自托管高级场景
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_key: Option<String>,
    /// 配对令牌（服务器签发，只存明文于本机配置）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// 配对时声明的设备名
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    /// 配对成功时刻（Unix 秒）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paired_at: Option<i64>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            config_version: 1,
            server_url: DEFAULT_SERVER_URL.to_owned(),
            autostart: true,
            tracking_enabled: true,
            notifications_enabled: true,
            pill_position: PillPosition::default(),
            data_key: None,
            token: None,
            device_name: None,
            paired_at: None,
        }
    }
}

impl Config {
    /// 是否已配对（token 非空）
    pub fn is_paired(&self) -> bool {
        self.token.as_deref().map(|t| !t.is_empty()).unwrap_or(false)
    }

    /// 解析后的加密密钥；未配对且未手动配置时为 None
    pub fn crypto_key(&self) -> Option<&str> {
        self.data_key.as_deref()
    }
}

/// 默认设备名：Windows 主机名，取不到时回退 "Desktop"
pub fn default_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Desktop".to_owned())
}

pub fn data_dir() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_owned());
    PathBuf::from(base).join("Anchor")
}

pub fn config_path() -> PathBuf {
    data_dir().join("config.toml")
}

pub fn load() -> Config {
    let path = config_path();
    match std::fs::read_to_string(&path) {
        Ok(text) => match toml::from_str::<Config>(&text) {
            Ok(cfg) => {
                log::info!("已加载配置: {path:?}");
                cfg
            }
            Err(e) => {
                log::warn!("配置解析失败，使用默认值: {e}");
                Config::default()
            }
        },
        Err(_) => {
            let cfg = Config::default();
            if let Err(e) = save(&cfg) {
                log::warn!("写入默认配置失败: {e}");
            }
            cfg
        }
    }
}

pub fn save(cfg: &Config) -> std::io::Result<()> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir)?;
    let text = toml::to_string_pretty(cfg).map_err(std::io::Error::other)?;
    std::fs::write(config_path(), text)
}

/// http(s)://host → ws(s)://host/ws
pub fn ws_url(server_url: &str) -> String {
    let base = server_url.trim_end_matches('/');
    let ws = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        format!("ws://{base}")
    };
    format!("{ws}/ws")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 老 config.toml（无配对新字段）须能正常加载（向后兼容）
    #[test]
    fn old_toml_without_pairing_fields_loads() {
        let text = r#"
config_version = 1
server_url = "http://192.168.1.10:4000"
autostart = true
tracking_enabled = true
notifications_enabled = false
"#;
        let cfg: Config = toml::from_str(text).expect("老配置加载失败");
        assert_eq!(cfg.server_url, "http://192.168.1.10:4000");
        assert!(!cfg.is_paired());
        assert!(cfg.token.is_none());
        assert!(cfg.device_name.is_none());
        assert!(cfg.paired_at.is_none());
        assert!(cfg.crypto_key().is_none());
    }

    #[test]
    fn is_paired_logic() {
        let mut cfg = Config::default();
        assert!(!cfg.is_paired());
        cfg.token = Some(String::new());
        assert!(!cfg.is_paired(), "空 token 不算已配对");
        cfg.token = Some("tok-abc".to_owned());
        assert!(cfg.is_paired());
    }

    #[test]
    fn serialize_roundtrip_with_pairing_fields() {
        let mut cfg = Config::default();
        cfg.token = Some("tok-xyz".to_owned());
        cfg.device_name = Some("study-pc".to_owned());
        cfg.data_key = Some("server-issued-key".to_owned());
        cfg.paired_at = Some(1_750_000_000);
        let text = toml::to_string_pretty(&cfg).expect("序列化失败");
        let back: Config = toml::from_str(&text).expect("反序列化失败");
        assert!(back.is_paired());
        assert_eq!(back.device_name.as_deref(), Some("study-pc"));
        assert_eq!(back.data_key.as_deref(), Some("server-issued-key"));
        assert_eq!(back.paired_at, Some(1_750_000_000));
    }

    #[test]
    fn ws_url_conversion() {
        assert_eq!(ws_url("http://localhost:4000/"), "ws://localhost:4000/ws");
        assert_eq!(ws_url("https://a.b:4000"), "wss://a.b:4000/ws");
    }
}
