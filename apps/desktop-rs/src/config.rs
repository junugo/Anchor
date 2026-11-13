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
    /// 上行行为数据加密密钥（可选，缺省用内置开发密钥）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_key: Option<String>,
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
        }
    }
}

impl Config {
    /// 解析后的加密密钥
    pub fn crypto_key(&self) -> &str {
        self.data_key
            .as_deref()
            .unwrap_or(crate::crypto::DEFAULT_DATA_KEY)
    }
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

    cfg
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
