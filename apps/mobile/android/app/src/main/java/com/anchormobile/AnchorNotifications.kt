package com.anchormobile

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.anchormobile.R
import kotlin.math.ceil
import kotlin.math.max

object AnchorNotifications {
    const val CHANNEL_SUNSET       = "anchor-sunset"
    const val CHANNEL_INTERVENTION = "anchor-intervention"
    const val CHANNEL_GENERAL      = "anchor-general"
    const val CHANNEL_WAKEUP       = "anchor-wakeup"
    const val CHANNEL_SERVICE      = "anchor-service"

    // 固定通知 ID，避免堆积
    const val NOTIF_SUNSET_COUNTDOWN = 2001
    const val NOTIF_SUNSET_CURFEW    = 2003
    const val NOTIF_INTERVENTION     = 3001
    const val NOTIF_AI               = 4001
    const val NOTIF_INTENT           = 4002
    const val NOTIF_INTENT_CONFIRM   = 4005
    const val NOTIF_WAKEUP           = 7001
    const val NOTIF_SLEEP_CONFIRM    = 7002
    const val NOTIF_CONTEXT_SWITCH   = 7003
    const val NOTIF_ACCESSIBILITY_LOST = 8001
    const val NOTIF_PAIR_INVALID       = 8002

    private const val WAKEUP_REQUEST = 8101

    fun init(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        listOf(
            NotificationChannel(CHANNEL_SUNSET,       context.getString(R.string.channel_sunset), NotificationManager.IMPORTANCE_HIGH),
            NotificationChannel(CHANNEL_INTERVENTION, context.getString(R.string.channel_intervention), NotificationManager.IMPORTANCE_HIGH),
            NotificationChannel(CHANNEL_GENERAL,      context.getString(R.string.channel_general), NotificationManager.IMPORTANCE_DEFAULT),
            NotificationChannel(CHANNEL_WAKEUP,       context.getString(R.string.channel_wakeup), NotificationManager.IMPORTANCE_HIGH),
        ).forEach(manager::createNotificationChannel)
    }

    /** 宵禁倒计时：T60/T30 进度条（共用同一 ID），T0 全屏，off 清除 */
    fun showPhase(context: Context, phase: String, bedtimeAtSeconds: Long? = null) {
        init(context)
        val manager = context.getSystemService(NotificationManager::class.java)
        val remainingMinutes = bedtimeAtSeconds?.let {
            max(0, ceil((it * 1000L - System.currentTimeMillis()) / 60_000.0).toInt())
        }
        when (phase) {
            "T60" -> manager.notify(NOTIF_SUNSET_COUNTDOWN, NotificationCompat.Builder(context, CHANNEL_SUNSET)
                .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
                .setContentTitle(remainingMinutes?.let { "距离就寝还有 $it 分钟" } ?: context.getString(R.string.notif_sunset_t60_title))
                .setProgress(60, remainingMinutes ?: 60, false)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setOngoing(true)
                .setAutoCancel(false)
                .build())
            "T30" -> manager.notify(NOTIF_SUNSET_COUNTDOWN, NotificationCompat.Builder(context, CHANNEL_SUNSET)
                .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
                .setContentTitle(remainingMinutes?.let { "距离就寝还有 $it 分钟" } ?: context.getString(R.string.notif_sunset_t30_title))
                .setContentText(context.getString(R.string.notif_sunset_t30_text))
                .setProgress(60, remainingMinutes ?: 30, false)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setOngoing(true)
                .setAutoCancel(false)
                .build())
            "T0" -> {
                manager.cancel(NOTIF_SUNSET_COUNTDOWN)
                val launch = PendingIntent.getActivity(context, 0, Intent(context, CurfewActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                manager.notify(NOTIF_SUNSET_CURFEW, NotificationCompat.Builder(context, CHANNEL_SUNSET)
                    .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
                    .setContentTitle(context.getString(R.string.notif_sunset_t0_title))
                    .setContentText(context.getString(R.string.notif_sunset_t0_text))
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_ALARM)
                    .setOngoing(true)
                    .setFullScreenIntent(launch, true)
                    .setContentIntent(launch)
                    .build())
            }
            "off" -> {
                manager.cancel(NOTIF_SUNSET_COUNTDOWN)
                manager.cancel(NOTIF_SUNSET_CURFEW)
            }
        }
    }

    /** 状态切换弹窗：全屏拉起 ContextSwitchActivity（注意力残留采集） */
    fun showContextSwitch(context: Context) {
        init(context)
        val launch = PendingIntent.getActivity(context, 7003, Intent(context, ContextSwitchActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        context.getSystemService(NotificationManager::class.java).notify(NOTIF_CONTEXT_SWITCH, NotificationCompat.Builder(context, CHANNEL_INTERVENTION)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(context.getString(R.string.context_switch_title))
            .setContentText(context.getString(R.string.context_switch_body))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setFullScreenIntent(launch, true)
            .setContentIntent(launch)
            .setAutoCancel(true)
            .build())
    }

    fun cancelContextSwitch(context: Context) {
        context.getSystemService(NotificationManager::class.java).cancel(NOTIF_CONTEXT_SWITCH)
    }

    /** 强干预：全屏 + 回去工作 / 我在休息 */
    fun showStrongIntervention(context: Context, message: String, detectedApp: String? = null) {
        init(context)
        val body = if (detectedApp != null) message + "\n" + context.getString(R.string.intervention_detected_format, detectedApp) else message
        val launch   = PendingIntent.getActivity(context, 3001, Intent(context, InterventionActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val accept   = PendingIntent.getBroadcast(context, 3002, Intent(context, AnchorNotificationReceiver::class.java).apply { action = AnchorNotificationReceiver.ACTION_INTERVENTION_ACCEPT }, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val dismiss  = PendingIntent.getBroadcast(context, 3003, Intent(context, AnchorNotificationReceiver::class.java).apply { action = AnchorNotificationReceiver.ACTION_INTERVENTION_DISMISS }, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        context.getSystemService(NotificationManager::class.java).notify(NOTIF_INTERVENTION, NotificationCompat.Builder(context, CHANNEL_INTERVENTION)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle(context.getString(R.string.notif_intervention_title))
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setFullScreenIntent(launch, true)
            .setContentIntent(launch)
            .addAction(0, context.getString(R.string.notif_intervention_btn_accept), accept)
            .addAction(0, context.getString(R.string.notif_intervention_btn_reject), dismiss)
            .setAutoCancel(true)
            .build())
    }

    /** 软干预：横幅 + 知道了 */
    fun showSoftIntervention(context: Context, message: String) {
        init(context)
        val dismiss = PendingIntent.getBroadcast(context, 3004, Intent(context, AnchorNotificationReceiver::class.java).apply { action = AnchorNotificationReceiver.ACTION_INTERVENTION_DISMISS }, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        context.getSystemService(NotificationManager::class.java).notify(NOTIF_INTERVENTION, NotificationCompat.Builder(context, CHANNEL_INTERVENTION)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(context.getString(R.string.notif_intervention_title))
            .setContentText(message)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .addAction(0, context.getString(R.string.notif_soft_btn_dismiss), dismiss)
            .setAutoCancel(true)
            .build())
    }

    /** AI 提醒：静默，autoCancel，无按钮 */
    fun showAi(context: Context, message: String) {
        init(context)
        context.getSystemService(NotificationManager::class.java).notify(NOTIF_AI, NotificationCompat.Builder(context, CHANNEL_GENERAL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Anchor")
            .setContentText(message)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .build())
    }

    /** 意图捕获：常驻通知（重开入口），点 body /「记录」打开输入界面，「稍后」仅收起 */
    fun showIntentCapture(context: Context, prompt: String) {
        init(context)
        val open = PendingIntent.getActivity(context, 4003, Intent(context, IntentCaptureActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val skip = PendingIntent.getBroadcast(context, 4004, Intent(context, AnchorNotificationReceiver::class.java).apply { action = AnchorNotificationReceiver.ACTION_INTENT_SKIP }, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        context.getSystemService(NotificationManager::class.java).notify(NOTIF_INTENT, NotificationCompat.Builder(context, CHANNEL_GENERAL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(context.getString(R.string.notif_intent_title))
            .setContentText(prompt)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(open)
            .addAction(0, context.getString(R.string.notif_intent_btn_record), open)
            .addAction(0, context.getString(R.string.notif_intent_btn_skip), skip)
            .setOngoing(true)
            .setAutoCancel(false)
            .build())
    }

    fun cancelIntentCapture(context: Context) {
        context.getSystemService(NotificationManager::class.java).cancel(NOTIF_INTENT)
    }

    /** 晨起意图确认：非静默通知，「确认」直接上报，点 body 进 App */
    fun showIntentConfirm(context: Context, date: String, content: String) {
        init(context)
        val open = PendingIntent.getActivity(context, 4006, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val confirm = PendingIntent.getBroadcast(context, 4007, Intent(context, AnchorNotificationReceiver::class.java).apply { action = AnchorNotificationReceiver.ACTION_INTENT_CONFIRM; putExtra("date", date) }, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        context.getSystemService(NotificationManager::class.java).notify(NOTIF_INTENT_CONFIRM, NotificationCompat.Builder(context, CHANNEL_GENERAL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(context.getString(R.string.notif_intent_confirm_title))
            .setContentText(content)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(open)
            .addAction(0, context.getString(R.string.notif_intent_confirm_btn), confirm)
            .setAutoCancel(true)
            .build())
    }

    fun cancelIntentConfirm(context: Context) {
        context.getSystemService(NotificationManager::class.java).cancel(NOTIF_INTENT_CONFIRM)
    }

    /** 起床闹钟：保持不变 */
    fun showWakeup(context: Context) {
        init(context)
        val intent = PendingIntent.getActivity(context, 7001, Intent(context, WakeupActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        context.getSystemService(NotificationManager::class.java).notify(NOTIF_WAKEUP, NotificationCompat.Builder(context, CHANNEL_WAKEUP)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle(context.getString(R.string.notif_wakeup_title))
            .setContentText(context.getString(R.string.notif_wakeup_text))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setOngoing(true)
            .setFullScreenIntent(intent, true)
            .setContentIntent(intent)
            .build())
    }

    fun scheduleWakeup(context: Context, atMillis: Long) {
        val alarm  = context.getSystemService(AlarmManager::class.java)
        val intent = PendingIntent.getBroadcast(context, WAKEUP_REQUEST, Intent(context, AnchorAlarmReceiver::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        alarm.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMillis, intent)
    }

    /** 入睡确认：全屏打开 SleepConfirmActivity（可见的「还没睡」按钮），通知栏按钮兜底 */
    fun showSleepConfirm(context: Context, confirmUntilSeconds: Long) {
        init(context)
        val notYet = PendingIntent.getBroadcast(context, 7002, Intent(context, AnchorNotificationReceiver::class.java).apply { action = AnchorNotificationReceiver.ACTION_SLEEP_CONFIRM_NOT_YET }, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val launch = PendingIntent.getActivity(context, 7003, Intent(context, SleepConfirmActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        context.getSystemService(NotificationManager::class.java).notify(NOTIF_SLEEP_CONFIRM, NotificationCompat.Builder(context, CHANNEL_WAKEUP)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle(context.getString(R.string.notif_sleep_confirm_title))
            .setContentText(context.getString(R.string.notif_sleep_confirm_text))
            .setStyle(NotificationCompat.BigTextStyle().bigText(context.getString(R.string.notif_sleep_confirm_text)))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setOngoing(true)
            .setFullScreenIntent(launch, true)
            .setContentIntent(launch)
            .addAction(0, context.getString(R.string.notif_sleep_confirm_btn_notyet), notYet)
            // 本地兜底：窗口到期自动消失（服务器 timeout 也会发 sleep:confirm-cancel）
            .setTimeoutAfter(max(0L, confirmUntilSeconds * 1000L - System.currentTimeMillis()))
            .build())
    }

    fun cancelSleepConfirm(context: Context) {
        context.getSystemService(NotificationManager::class.java).cancel(NOTIF_SLEEP_CONFIRM)
    }

    /** 配对失效提醒：点击回到主界面（设置页内可重新配对） */
    fun showPairInvalid(context: Context) {
        init(context)
        val open = PendingIntent.getActivity(
            context, 8003, Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        context.getSystemService(NotificationManager::class.java).notify(
            NOTIF_PAIR_INVALID,
            NotificationCompat.Builder(context, CHANNEL_GENERAL)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle(context.getString(R.string.notif_pair_invalid_title))
                .setContentText(context.getString(R.string.notif_pair_invalid_text))
                .setStyle(NotificationCompat.BigTextStyle().bigText(context.getString(R.string.notif_pair_invalid_text)))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(open)
                .setAutoCancel(true)
                .build(),
        )
    }

    /** 无障碍权限丢失提醒：点击直达无障碍设置页（系统停用服务后用户需重新开启） */
    fun showAccessibilityLost(context: Context) {
        init(context)
        val settings = PendingIntent.getActivity(
            context, 8002, Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        context.getSystemService(NotificationManager::class.java).notify(
            NOTIF_ACCESSIBILITY_LOST,
            NotificationCompat.Builder(context, CHANNEL_GENERAL)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle(context.getString(R.string.notif_accessibility_lost_title))
                .setContentText(context.getString(R.string.notif_accessibility_lost_text))
                .setStyle(NotificationCompat.BigTextStyle().bigText(context.getString(R.string.notif_accessibility_lost_text)))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(settings)
                .setAutoCancel(true)
                .build(),
        )
    }
}
