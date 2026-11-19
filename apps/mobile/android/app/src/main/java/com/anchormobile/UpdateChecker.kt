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

    /** 检查结果三态：有新版 / 已是最新 / 失败（区分 Toast 文案） */
    sealed interface CheckResult {
        data class NewVersion(val info: UpdateLogic.UpdateInfo) : CheckResult
        object UpToDate : CheckResult
        object Failed : CheckResult
    }

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
     * 自动路径被节流时返回 null（静默不打扰）；其余返回三态结果。
     */
    suspend fun check(context: Context, force: Boolean = false): CheckResult? =
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
                    if (!resp.isSuccessful) return@withContext CheckResult.Failed
                    val body = resp.body?.string() ?: return@withContext CheckResult.Failed
                    val info = UpdateLogic.parseLatestRelease(body) ?: return@withContext CheckResult.Failed
                    if (UpdateLogic.isNewer(info.version, BuildConfig.VERSION_NAME)) {
                        CheckResult.NewVersion(info)
                    } else {
                        CheckResult.UpToDate
                    }
                }
            } catch (_: Exception) {
                CheckResult.Failed
            }
        }

    /** 下载 apk 到应用私有外部目录；失败或字节数不符返回 null */
    suspend fun downloadApk(context: Context, info: UpdateLogic.UpdateInfo): File? =
        withContext(Dispatchers.IO) {
            var dest: File? = null
            try {
                val d = File(
                    context.getExternalFilesDir(null) ?: return@withContext null,
                    "anchor-update-${info.version}.apk",
                )
                dest = d
                val req = Request.Builder().url(info.apkUrl).header("User-Agent", UpdateLogic.USER_AGENT).build()
                client.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) return@withContext null
                    val body = resp.body ?: return@withContext null
                    val expectLen = body.contentLength() // -1 = 服务器未声明，跳过一致性校验
                    var written = 0L
                    body.byteStream().use { input ->
                        d.outputStream().use { out ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                val n = input.read(buf)
                                if (n < 0) break
                                out.write(buf, 0, n)
                                written += n
                            }
                        }
                    }
                    // 完整性校验：Content-Length 与实际写入不一致视为下载失败
                    if (expectLen >= 0 && written != expectLen) {
                        d.delete()
                        return@withContext null
                    }
                }
                d
            } catch (_: Exception) {
                dest?.delete()
                null
            }
        }

    /** FileProvider 授予读权限并发起系统安装（需 REQUEST_INSTALL_PACKAGES 权限）；异常 Toast 引导 */
    fun installApk(context: Context, apk: File) {
        try {
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
        } catch (e: Exception) {
            // ActivityNotFoundException（无可用安装器）/ SecurityException（权限未授）等
            android.util.Log.w("AnchorUpdate", "installApk 失败", e)
            toast(context, "无法调起安装器，请在系统设置中允许安装未知应用后重试")
        }
    }

    fun toast(context: Context, msg: String) {
        Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
    }
}
