package com.anchormobile

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 处理通知按钮点击回调
 * 接收干预、意图捕获等通知的 Action PendingIntent
 */
class AnchorNotificationReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_INTERVENTION_ACCEPT -> {
                AnchorRuntime.respondToIntervention("accepted")
                cancelNotif(context, AnchorNotifications.NOTIF_INTERVENTION)
            }
            ACTION_INTERVENTION_DISMISS -> {
                AnchorRuntime.respondToIntervention("rejected")
                cancelNotif(context, AnchorNotifications.NOTIF_INTERVENTION)
            }
            ACTION_INTENT_SKIP -> {
                // 用户选择稍后：有活跃捕获则上报 skip（全端关弹窗），通知一并收起
                AnchorRuntime.state.value.intentCapture?.promptId?.takeIf { it.isNotEmpty() }?.let {
                    AnchorRuntime.captureResponse(it, "skip")
                }
                cancelNotif(context, AnchorNotifications.NOTIF_INTENT)
            }
            ACTION_INTENT_CONFIRM -> {
                val date = intent.getStringExtra("date") ?: ""
                if (date.isNotEmpty()) AnchorRuntime.confirmIntent(date)
                cancelNotif(context, AnchorNotifications.NOTIF_INTENT_CONFIRM)
            }
            ACTION_SLEEP_CONFIRM_NOT_YET -> {
                // 入睡确认框「还没睡」：点到即回答 = 醒着
                AnchorRuntime.send(mapOf("type" to "sleep:confirm-response", "confirmed" to false))
                cancelNotif(context, AnchorNotifications.NOTIF_SLEEP_CONFIRM)
            }
        }
    }

    private fun cancelNotif(context: Context, id: Int) {
        context.getSystemService(NotificationManager::class.java).cancel(id)
    }

    companion object {
        const val ACTION_INTERVENTION_ACCEPT  = "anchor.action.INTERVENTION_ACCEPT"
        const val ACTION_INTERVENTION_DISMISS = "anchor.action.INTERVENTION_DISMISS"
        const val ACTION_INTENT_SKIP          = "anchor.action.INTENT_SKIP"
        const val ACTION_INTENT_CONFIRM       = "anchor.action.INTENT_CONFIRM"
        const val ACTION_SLEEP_CONFIRM_NOT_YET = "anchor.action.SLEEP_CONFIRM_NOT_YET"
    }
}
