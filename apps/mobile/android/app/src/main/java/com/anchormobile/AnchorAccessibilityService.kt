package com.anchormobile

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.accessibility.AccessibilityEvent
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

class AnchorAccessibilityService : AccessibilityService() {
    private val handler = Handler(Looper.getMainLooper())
    private var lastBlockedPackage: String? = null
    private var lastBlockedAt = 0L

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // 单个事件处理异常绝不能拖垮整个服务：系统检测到无障碍服务崩溃会自动停用（权限「丢失」）
        try {
            handleEvent(event)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun handleEvent(event: AccessibilityEvent?) {
        if (event == null) return

        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            event.eventType != AccessibilityEvent.TYPE_WINDOWS_CHANGED) return

        val packageName = event.packageName?.toString() ?: return

        // 无论什么阶段都触发分类，确保未知应用始终被记录
        if (!isAllowedPackage(packageName) && !isHighStimulusPackage(packageName)) {
            requestClassification(packageName)
        }

        val phase = AnchorRuntime.state.value.sunsetPhase
        if (phase != "T15" && phase != "T0") return
        if (isAllowedPackage(packageName)) return
        if (isHighStimulusPackage(packageName)) {
            val now = System.currentTimeMillis()
            if (packageName == lastBlockedPackage && now - lastBlockedAt < 500L) return
            lastBlockedPackage = packageName
            lastBlockedAt = now
            blockWithRetry(packageName, 0)
        }
    }

    private fun blockWithRetry(packageName: String, attempt: Int) {
        if (AnchorRuntime.state.value.sunsetPhase == "off") return
        if (isAllowedPackage(packageName)) return
        handler.postDelayed({
            try {
                startActivity(Intent(this, CurfewActivity::class.java).apply {
                    addFlags(
                        Intent.FLAG_ACTIVITY_NEW_TASK or
                            Intent.FLAG_ACTIVITY_CLEAR_TOP or
                            Intent.FLAG_ACTIVITY_SINGLE_TOP or
                            Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                            Intent.FLAG_ACTIVITY_NO_ANIMATION,
                    )
                })
                if (attempt < 2) blockWithRetry(packageName, attempt + 1)
            } catch (e: Exception) {
                // 后台启动受限（Android 10+/MIUI）时静默失败，不重试
            }
        }, if (attempt == 0) 50L else 250L)
    }

    private fun isAllowedPackage(packageName: String): Boolean {
        val home = packageManager.resolveActivity(
            Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), 0,
        )?.activityInfo?.packageName
        return packageName == this.packageName ||
            packageName == "com.android.systemui" ||
            packageName == "com.android.settings" ||
            packageName == home ||
            packageName == "com.android.dialer" ||
            packageName == "com.android.phone"
    }

    private fun requestClassification(packageName: String) {
        val prefs = getSharedPreferences("anchor", MODE_PRIVATE)
        // 三态键任一命中即视为已分类（work 应用 high/low 均为 false，缺 work 检查会重复请求）
        if (prefs.getBoolean("classified_high_$packageName", false) || prefs.getBoolean("classified_low_$packageName", false) || prefs.getBoolean("classified_work_$packageName", false)) return
        val appName = runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(packageName, 0)).toString() }.getOrDefault(packageName)

        // 收集应用详情用于 AI 分类和展示
        val appInfo = collectAppInfo(packageName)

        Thread {
            try {
                val serverUrl = prefs.getString("server_url", AnchorRuntime.DEFAULT_SERVER_URL) ?: return@Thread
                val client = okhttp3.OkHttpClient.Builder().connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS).build()
                val payload = mutableMapOf<String, Any?>(
                    "package_name" to packageName,
                    "app_name" to appName,
                    "version_name" to appInfo.versionName,
                    "category" to appInfo.category,
                    "process_name" to appInfo.processName,
                    "icon_base64" to appInfo.iconBase64,
                )
                val json = com.google.gson.Gson().toJson(payload)
                val request = okhttp3.Request.Builder()
                    .url("$serverUrl/api/apps/classify")
                    .post(json.toRequestBody("application/json".toMediaType()))
                    .build()
                val response = client.newCall(request).execute()
                if (response.isSuccessful) {
                    val result = com.google.gson.Gson().fromJson(response.body?.string(), com.google.gson.JsonObject::class.java)
                    val highStimulus = result.get("high_stimulus")?.asBoolean ?: false
                    val isWork = result.get("is_work")?.asBoolean ?: false
                    prefs.edit()
                        .putBoolean("classified_high_$packageName", highStimulus && !isWork)
                        .putBoolean("classified_low_$packageName", !highStimulus && !isWork)
                        .putBoolean("classified_work_$packageName", isWork)
                        .apply()
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }.start()
    }

    private data class AppExtraInfo(
        val versionName: String = "",
        val category: String = "",
        val processName: String = "",
        val iconBase64: String = "",
    )

    private fun collectAppInfo(packageName: String): AppExtraInfo {
        return runCatching {
            val pm = packageManager
            val pkgInfo = pm.getPackageInfo(packageName, 0)
            val appInfo = pm.getApplicationInfo(packageName, 0)

            val versionName = pkgInfo.versionName ?: ""
            val processName = appInfo.processName ?: packageName
            val category = if (Build.VERSION.SDK_INT >= 26) {
                appInfo.category.let {
                    when (it) {
                        ApplicationInfo.CATEGORY_GAME -> "GAME"
                        ApplicationInfo.CATEGORY_AUDIO -> "AUDIO"
                        ApplicationInfo.CATEGORY_VIDEO -> "VIDEO"
                        ApplicationInfo.CATEGORY_IMAGE -> "IMAGE"
                        ApplicationInfo.CATEGORY_SOCIAL -> "SOCIAL"
                        ApplicationInfo.CATEGORY_NEWS -> "NEWS"
                        ApplicationInfo.CATEGORY_MAPS -> "MAPS"
                        ApplicationInfo.CATEGORY_PRODUCTIVITY -> "PRODUCTIVITY"
                        else -> "OTHER"
                    }
                }
            } else ""

            val iconBase64 = encodeIcon(pm.getApplicationIcon(appInfo))

            AppExtraInfo(versionName, category, processName, iconBase64)
        }.getOrDefault(AppExtraInfo())
    }

    private fun encodeIcon(drawable: android.graphics.drawable.Drawable): String {
        return runCatching {
            val width = drawable.intrinsicWidth.coerceAtMost(96)
            val height = drawable.intrinsicHeight.coerceAtMost(96)
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            drawable.setBounds(0, 0, canvas.width, canvas.height)
            drawable.draw(canvas)
            val baos = java.io.ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.PNG, 80, baos)
            Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
        }.getOrDefault("")
    }


    private fun isHighStimulusPackage(packageName: String): Boolean {
        val prefs = getSharedPreferences("anchor", MODE_PRIVATE)
        return prefs.getBoolean("classified_high_$packageName", false)
    }

    private companion object {}

    override fun onInterrupt() = Unit
    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }
}


