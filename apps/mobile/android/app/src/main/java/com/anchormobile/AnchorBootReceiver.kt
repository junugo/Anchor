package com.anchormobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class AnchorBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action == Intent.ACTION_BOOT_COMPLETED) AnchorService.start(context)
    }
}
