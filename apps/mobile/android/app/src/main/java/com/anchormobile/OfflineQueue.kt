package com.anchormobile

import android.content.ContentValues
import android.content.Context
import android.database.DatabaseUtils
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * 离线队列：WS 断开时积压 ingest 事件（完整消息 JSON），重连后分块 POST /api/ingest/batch 补发。
 * 上限 500 条，超出 FIFO 淘汰最旧 10%；补发失败计重试，超过 MAX_RETRIES 丢弃。
 */
class OfflineQueue private constructor(context: Context) :
    SQLiteOpenHelper(context, "anchor-offline.db", null, 1) {

    companion object {
        private const val TABLE = "pending_events"
        private const val MAX_QUEUE_SIZE = 500
        private const val MAX_RETRIES = 5

        @Volatile
        private var instance: OfflineQueue? = null

        fun get(context: Context): OfflineQueue =
            instance ?: synchronized(this) {
                instance ?: OfflineQueue(context.applicationContext).also { instance = it }
            }
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS $TABLE (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                body    TEXT    NOT NULL,
                retries INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent()
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

    @Synchronized
    fun enqueue(body: String) {
        val db = writableDatabase
        if (DatabaseUtils.queryNumEntries(db, TABLE) >= MAX_QUEUE_SIZE) {
            val evict = MAX_QUEUE_SIZE / 10
            db.execSQL("DELETE FROM $TABLE WHERE id IN (SELECT id FROM $TABLE ORDER BY id ASC LIMIT $evict)")
        }
        db.insert(TABLE, null, ContentValues().apply { put("body", body) })
    }

    /** 最早的一批（id → body），按入队顺序 */
    @Synchronized
    fun pendingChunk(limit: Int): List<Pair<Long, String>> {
        val out = mutableListOf<Pair<Long, String>>()
        readableDatabase.rawQuery(
            "SELECT id, body FROM $TABLE ORDER BY id ASC LIMIT ?",
            arrayOf(limit.toString())
        ).use { c ->
            while (c.moveToNext()) out.add(c.getLong(0) to c.getString(1))
        }
        return out
    }

    @Synchronized
    fun remove(ids: List<Long>) {
        if (ids.isEmpty()) return
        writableDatabase.execSQL("DELETE FROM $TABLE WHERE id IN (${ids.joinToString(",")})")
    }

    @Synchronized
    fun bumpRetries(ids: List<Long>) {
        if (ids.isEmpty()) return
        writableDatabase.execSQL("UPDATE $TABLE SET retries = retries + 1 WHERE id IN (${ids.joinToString(",")})")
    }

    /** 重试超限的直接丢弃 */
    @Synchronized
    fun dropExpired() {
        writableDatabase.execSQL("DELETE FROM $TABLE WHERE retries >= $MAX_RETRIES")
    }
}
