//! 文件日志：%LOCALAPPDATA%\Anchor\logs\desktop.log（release 无控制台，排障依赖此文件）
//! 设置环境变量 RUST_LOG=debug 后，同时输出到控制台并启用 debug 级别（本地开发启动桌面时）。

use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::sync::Mutex;

const MAX_BYTES: u64 = 1_000_000;

struct FileLogger {
    file: Mutex<std::fs::File>,
    console: bool,
    max_level: log::LevelFilter,
}

impl log::Log for FileLogger {
    fn enabled(&self, meta: &log::Metadata) -> bool {
        if self.max_level == log::LevelFilter::Off {
            return false;
        }
        meta.level() <= self.max_level.to_level().unwrap()
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let Ok(mut f) = self.file.lock() else { return };
        let ts = time::OffsetDateTime::now_local()
            .map(|t| {
                format!(
                    "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
                    t.year(),
                    t.month() as u8,
                    t.day(),
                    t.hour(),
                    t.minute(),
                    t.second()
                )
            })
            .unwrap_or_else(|_| "----/--/-- --:--:--".to_owned());
        let line = format!("[{ts} {} {}] {}", record.level(), record.target(), record.args());
        let _ = writeln!(f, "{line}");
        let _ = f.flush();
        if self.console {
            let _ = writeln!(io::stdout(), "{line}");
        }
    }

    fn flush(&self) {}
}

pub fn init() {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_owned());
    let dir = format!("{base}\\Anchor\\logs");
    let _ = fs::create_dir_all(&dir);
    let path = format!("{dir}\\desktop.log");
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > MAX_BYTES {
            let _ = fs::remove_file(&path);
        }
    }
    // 未设置 RUST_LOG 时保持原行为：仅文件、Info 级别；设置后同时输出控制台并按级别过滤。
    let console = env::var("RUST_LOG").is_ok();
    let max_level = env::var("RUST_LOG")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(log::LevelFilter::Info);
    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(file) => {
            let _ = log::set_boxed_logger(Box::new(FileLogger {
                file: Mutex::new(file),
                console,
                max_level,
            }));
            log::set_max_level(max_level);
        }
        Err(e) => eprintln!("日志文件打开失败: {e}"),
    }
}
