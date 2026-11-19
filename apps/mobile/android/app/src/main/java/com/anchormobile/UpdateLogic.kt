package com.anchormobile

import com.google.gson.JsonParser

/**
 * 更新检查纯逻辑：与 Android 无关，便于本地单元测试（不引 mockwebserver）。
 * 网络部分见 UpdateChecker。
 */
object UpdateLogic {

    const val LATEST_API = "https://api.github.com/repos/junugo/Anchor/releases/latest"
    const val RELEASES_PAGE = "https://github.com/junugo/Anchor/releases"
    const val USER_AGENT = "Anchor-Mobile"
    const val LAST_CHECK_PREF = "update_last_check_at"
    /// 每天最多自动检查一次（毫秒）
    const val CHECK_INTERVAL_MS = 24L * 3600 * 1000

    data class UpdateInfo(
        /** 新版本号（如 1.2.3） */
        val version: String,
        /** 完整 tag（如 mobile-v1.2.3） */
        val tag: String,
        /** apk 资产下载地址 */
        val apkUrl: String,
    )

    /** latest 是否比 current 新（x.y.z 语义比较，容忍 v 前缀） */
    fun isNewer(latest: String, current: String): Boolean {
        val l = parseVersion(latest) ?: return false
        val c = parseVersion(current) ?: return false
        return when {
            l.first != c.first -> l.first > c.first
            l.second != c.second -> l.second > c.second
            else -> l.third > c.third
        }
    }

    /** 解析 x.y.z（容忍 v 前缀，缺段补 0）；非法返回 null */
    fun parseVersion(s: String): Triple<Int, Int, Int>? {
        val core = s.trim().removePrefix("v").split('-', '+').first()
        val parts = core.split('.')
        if (parts.isEmpty() || parts.size > 3) return null
        if (parts.any { it.toIntOrNull() == null }) return null
        return Triple(
            parts[0].toInt(),
            parts.getOrElse(1) { "0" }.toInt(),
            parts.getOrElse(2) { "0" }.toInt(),
        )
    }

    /**
     * 从 release JSON 中解析移动端资产（Gson 解析，本地单测可跑）。
     * 发布资产命名约定：单一 v* tag 流（如 v2.0.0），资产 = anchor-mobile-{version}-debug.apk
     * （兼容旧 mobile-vX.Y.Z tag 与无 -debug 后缀资产名）
     */
    fun parseLatestRelease(body: String): UpdateInfo? {
        return try {
            val root = JsonParser.parseString(body).asJsonObject
            val tag = root.get("tag_name")?.asString?.trim().orEmpty()
            val version = when {
                tag.startsWith("mobile-v") -> return null // 旧移动端分 tag 流，非全量发布
                tag.startsWith("v") -> tag.removePrefix("v")
                else -> return null
            }
            val expectedNames = setOf(
                "anchor-mobile-$version.apk",
                "anchor-mobile-$version-debug.apk",
            )
            val assets = root.getAsJsonArray("assets") ?: return null
            for (el in assets) {
                val a = el.asJsonObject
                if (a.get("name")?.asString in expectedNames) {
                    val url = a.get("browser_download_url")?.asString.orEmpty()
                    if (url.isNotEmpty()) return UpdateInfo(version, tag, url)
                }
            }
            null
        } catch (_: Exception) {
            null
        }
    }

    /** 距离上次检查是否超过一天（SharedPreferences 存的毫秒时间戳） */
    fun shouldCheck(nowMs: Long, lastCheckMs: Long): Boolean =
        nowMs - lastCheckMs >= CHECK_INTERVAL_MS
}
