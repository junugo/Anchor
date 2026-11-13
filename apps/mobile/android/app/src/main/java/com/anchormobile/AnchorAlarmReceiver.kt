package com.anchormobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.anchormobile.R

class AnchorAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        AnchorNotifications.init(context)
        AnchorNotifications.showAi(context, context.getString(R.string.notif_alarm_ai_text))
        AnchorRuntime.send(mapOf("type" to "ingest", "source" to "android", "event_type" to "wakeup_alarm_fired", "payload" to mapOf("timestamp" to System.currentTimeMillis() / 1000)))
    }
}
