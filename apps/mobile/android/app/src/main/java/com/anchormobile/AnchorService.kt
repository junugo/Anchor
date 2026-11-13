package com.anchormobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.usage.UsageStatsManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.anchormobile.R
import kotlin.math.sqrt

class AnchorService : Service(), SensorEventListener {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var usageStats: UsageStatsManager
    private lateinit var sensorManager: SensorManager
    private var lastCharging: Boolean? = null
    private val motion = mutableListOf<Float>()

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val event = when (intent.action) {
                Intent.ACTION_SCREEN_ON   -> "screen_on"
                Intent.ACTION_SCREEN_OFF  -> "screen_off"
                Intent.ACTION_USER_PRESENT -> "screen_unlock"
                else -> return
            }
            ingest(event, mapOf("timestamp" to System.currentTimeMillis() / 1000))
        }
    }

    private val usagePoll = object : Runnable {
        override fun run() { reportForegroundApp(); handler.postDelayed(this, 15_000) }
    }

    private val snapshotPoll = object : Runnable {
        override fun run() { reportUsageSnapshot(); reportBattery(); reportMotion(); checkAccessibilityLost(); handler.postDelayed(this, 5 * 60_000L) }
    }

    /** 无障碍权限丢失检测：5min 轮询，24h 去抖提醒；丢失时发通知 + 上报服务器（统计丢失频率） */
    private fun checkAccessibilityLost() {
        try {
            val component = ComponentName(this, AnchorAccessibilityService::class.java).flattenToString()
            val enabled = android.provider.Settings.Secure.getString(contentResolver, "enabled_accessibility_services")
                ?.split(':')?.any { it.equals(component, true) } == true
            if (enabled) return
            val prefs = getSharedPreferences("anchor", MODE_PRIVATE)
            val now = System.currentTimeMillis()
            if (now - prefs.getLong("accessibility_lost_notified_at", 0L) < 24 * 60 * 60 * 1000L) return
            prefs.edit().putLong("accessibility_lost_notified_at", now).apply()
            AnchorNotifications.showAccessibilityLost(this)
            AnchorRuntime.send(mapOf(
                "type" to "ingest", "source" to "android", "event_type" to "accessibility_lost",
                "payload" to mapOf("timestamp" to System.currentTimeMillis() / 1000),
            ))
        } catch (e: Exception) {
            // 检测失败静默，不影响主循环
        }
    }

    /** T0 阶段守护：每 5 秒检查前台是否为宵禁页，若不是则强制弹回 */
    private val curfewGuard = object : Runnable {
        override fun run() {
            if (AnchorRuntime.state.value.sunsetPhase == "T0") {
                val foreground = getForegroundPackage()
                if (foreground != null && foreground != packageName) {
                    startActivity(Intent(this@AnchorService, CurfewActivity::class.java).apply {
                        addFlags(
                            Intent.FLAG_ACTIVITY_NEW_TASK or
                                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                                Intent.FLAG_ACTIVITY_SINGLE_TOP or
                                Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                                Intent.FLAG_ACTIVITY_NO_ANIMATION,
                        )
                    })
                }
            }
            handler.postDelayed(this, 5_000L)
        }
    }


    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForeground(NOTIFICATION_ID, buildForegroundNotification(this))
        usageStats = getSystemService(USAGE_STATS_SERVICE) as UsageStatsManager
        sensorManager = getSystemService(SENSOR_SERVICE) as SensorManager
        sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)?.let {
            sensorManager.registerListener(this, it, 1_000_000)
        }
        ContextCompat.registerReceiver(this, screenReceiver, IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_USER_PRESENT)
        }, ContextCompat.RECEIVER_EXPORTED)
        AnchorRuntime.start(this)
        handler.post(usagePoll)
        handler.post(snapshotPoll)
        handler.post(curfewGuard)
    }

    /** 返回当前前台应用包名，T0 守护使用 */
    private fun getForegroundPackage(): String? {
        return try {
            val now = System.currentTimeMillis()
            usageStats.queryUsageStats(android.app.usage.UsageStatsManager.INTERVAL_BEST, now - 5_000, now)
                .maxByOrNull { it.lastTimeUsed }?.packageName
        } catch (_: SecurityException) { null }
    }

    private fun reportForegroundApp() {
        try {
            val now   = System.currentTimeMillis()
            val stats = usageStats.queryUsageStats(UsageStatsManager.INTERVAL_BEST, now - 120_000, now)
            val top   = stats.maxByOrNull { it.lastTimeUsed } ?: return
            // 心跳语义：每 15s 上报当前前台（不去重）——服务器靠连续心跳维持「当下在 App 中」
            // 新鲜度过滤：lastTimeUsed 超 20s 视为非真实前台（MIUI 卡死/退出未报时不再产生假前台）
            if (top.packageName == packageName) return
            if (top.lastTimeUsed < now - 20_000) return
            val name = runCatching {
                packageManager.getApplicationLabel(packageManager.getApplicationInfo(top.packageName, 0)).toString()
            }.getOrDefault(top.packageName)
            ingest("app_foreground", mapOf("packageName" to top.packageName, "appName" to name))
        } catch (_: SecurityException) { }
    }

    private fun reportUsageSnapshot() {
        try {
            val end   = System.currentTimeMillis()
            val start = end - 5 * 60_000L
            val apps  = usageStats.queryAndAggregateUsageStats(start, end).values
                .filter { it.totalTimeInForeground > 0 }
                .map { mapOf("packageName" to it.packageName, "appName" to it.packageName, "totalMs" to it.totalTimeInForeground) }
            if (apps.isNotEmpty()) ingest("app_usage_snapshot", mapOf("apps" to apps, "window_start" to start, "window_end" to end))
        } catch (_: SecurityException) { }
    }

    private fun reportBattery() {
        val battery = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return
        val level   = battery.getIntExtra("level", -1)
        val scale   = battery.getIntExtra("scale", 100)
        val status  = battery.getIntExtra("status", -1)
        val charging = status == 2 || status == 5
        if (charging != lastCharging) {
            lastCharging = charging
            ingest("battery_charging", mapOf("is_charging" to charging, "level_pct" to (level * 100 / scale.coerceAtLeast(1))))
        }
    }

    private fun reportMotion() {
        if (motion.isEmpty()) return
        val average = motion.average()
        val walking = average > 11f
        ingest("physical_activity", mapOf("step_count_delta" to if (walking) (motion.size * .8).toInt() else 0, "activity_type" to if (walking) "walking" else "still"))
        motion.clear()
    }

    private fun ingest(event: String, payload: Map<String, Any?>) {
        AnchorRuntime.send(mapOf("type" to "ingest", "source" to "android", "event_type" to event, "payload" to payload))
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (event.sensor.type == Sensor.TYPE_ACCELEROMETER)
            motion += sqrt(event.values[0] * event.values[0] + event.values[1] * event.values[1] + event.values[2] * event.values[2])
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        sensorManager.unregisterListener(this)
        unregisterReceiver(screenReceiver)
        AnchorRuntime.stop()
        super.onDestroy()
    }

    private fun createChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(AnchorNotifications.CHANNEL_SERVICE, getString(R.string.channel_service), NotificationManager.IMPORTANCE_LOW)
        )
    }

    companion object {
        const val NOTIFICATION_ID = 4101

        /** 构建前台服务通知，文案根据当前 userState 动态生成 */
        fun buildForegroundNotification(context: Context): Notification {
            val stateLabel = userStateLabel(context, AnchorRuntime.state.value.userState)
            return NotificationCompat.Builder(context, AnchorNotifications.CHANNEL_SERVICE)
                .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
                .setContentTitle(context.getString(R.string.svc_foreground_title))
                .setContentText(stateLabel)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setContentIntent(
                    PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java),
                        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                )
                .build()
        }

        /** 由 AnchorRuntime.state:update 后调用，刷新前台通知文案 */
        fun updateForegroundNotification(context: Context) {
            context.getSystemService(NotificationManager::class.java)
                .notify(NOTIFICATION_ID, buildForegroundNotification(context))
        }

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, AnchorService::class.java))
        }
    }
}
