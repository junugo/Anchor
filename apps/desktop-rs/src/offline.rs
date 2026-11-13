//! 离线队列：WS 断开时的消息积压与重连重放（改进自旧版 offlineCache.ts——
//! 旧版只缓存 HTTP mutation，WS ingest 断开即丢；本实现统一入队）

use rusqlite::Connection;

use crate::config;

pub const MAX_RETRIES: u32 = 5;

pub struct OfflineQueue {
    conn: Connection,
}

impl OfflineQueue {
    pub fn open() -> rusqlite::Result<Self> {
        let dir = config::data_dir();
        let _ = std::fs::create_dir_all(&dir);
        let conn = Connection::open(dir.join("anchor-offline.db"))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS pending_ws (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                body       TEXT    NOT NULL,
                created_at INTEGER NOT NULL,
                retries    INTEGER NOT NULL DEFAULT 0
            )",
        )?;
        Ok(Self { conn })
    }

    pub fn enqueue(&self, body: &str) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        if let Err(e) = self.conn.execute(
            "INSERT INTO pending_ws (body, created_at) VALUES (?1, ?2)",
            rusqlite::params![body, now],
        ) {
            log::error!("[offline] 入队失败: {e}");
        }
    }

    /// 取出全部待重放消息（按入队顺序）
    pub fn pending(&self) -> Vec<(i64, String)> {
        let mut stmt = match self
            .conn
            .prepare("SELECT id, body FROM pending_ws ORDER BY id ASC")
        {
            Ok(s) => s,
            Err(e) => {
                log::error!("[offline] 读取失败: {e}");
                return Vec::new();
            }
        };
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    pub fn remove(&self, id: i64) {
        let _ = self
            .conn
            .execute("DELETE FROM pending_ws WHERE id = ?1", [id]);
    }

    pub fn bump_retry(&self, id: i64) {
        let _ = self.conn.execute(
            "UPDATE pending_ws SET retries = retries + 1 WHERE id = ?1",
            [id],
        );
    }

    pub fn retries_of(&self, id: i64) -> u32 {
        self.conn
            .query_row(
                "SELECT retries FROM pending_ws WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .unwrap_or(0)
    }

    pub fn len(&self) -> usize {
        self.conn
            .query_row("SELECT COUNT(*) FROM pending_ws", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap_or(0) as usize
    }
}
