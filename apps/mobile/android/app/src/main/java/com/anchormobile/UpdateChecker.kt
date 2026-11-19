package com.anchormobile

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.core.content.FileProvider
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * 移动端半自动更新：检查（每天最多一次）→ 对话框确认 → 下载 → FileProvider 发起安装。
 * 纯逻辑在 UpdateLogic（可单测）；此类只负责 Android 与网络副作用。
 */
object UpdateChecker {

    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    /** 上次自动检查时间戳（毫秒） */
    private fun lastCheckAt(context: Context): Long =
        context.getSharedPreferences("anchor", Context.MODE_PRIVATE)
            .getLong(UpdateLogic.LAST_CHECK_PREF, 0L)

    private fun markChecked(context: Context, nowMs: Long) {
        context.getSharedPreferences("anchor", Context.MODE_PRIVATE)
            .edit().putLong(UpdateLogic.LAST_CHECK_PREF, nowMs).apply()
    }

    /**
     * 检查更新。force=true 无视每日节流（用户手动点「检查更新」）。
     * 返回 null = 无新版/网络失败/被节流（静默，不打扰）。
     */
    suspend fun check(context: Context, force: Boolean = false): UpdateLogic.UpdateInfo? =
        withContext(Dispatchers.IO) {
            val now = System.currentTimeMillis()
            if (!force && !UpdateLogic.shouldCheck(now, lastCheckAt(context))) return@withContext null
            markChecked(context, now)
            try {
                val req = Request.Builder()
                    .url(UpdateLogic.LATEST_API)
                    .header("User-Agent", UpdateLogic.USER_AGENT)
                    .build()
                client.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) return@withContext null
                    val body = resp.body?.string() ?: return@withContext null
                    val info = UpdateLogic.parseLatestRelease(body) ?: return@withContext null
                    if (UpdateLogic.isNewer(info.version, BuildConfig.VERSION_NAME)) info else null
                }
            } catch (_: Exception) {
                null
            }
        }

    /** 下载 apk 到应用私有外部目录；失败返回 null */
    suspend fun downloadApk(context: Context, info: UpdateLogic.UpdateInfo): File? =
        withContext(Dispatchers.IO) {
            try {
                val dest = File(
                    context.getExternalFilesDir(null) ?: return@withContext null,
                    "anchor-update-${info.version}.apk",
                )
                val req = Request.Builder().url(info.apkUrl).header("User-Agent", UpdateLogic.USER_AGENT).build()
                client.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) return@withContext null
                    resp.body?.byteStream()?.use { input ->
                        dest.outputStream().use { input.copyTo(it) }
                    } ?: return@withContext null
                }
                dest
            } catch (_: Exception) {
                null
            }
        }

    /** FileProvider 授予读权限并发起系统安装（需 REQUEST_INSTALL_PACKAGES 权限） */
    fun installApk(context: Context, apk: File) {
        val uri: Uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            apk,
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }

    fun toast(context: Context, msg: String) {
        Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
    }
}
