package com.anchormobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.IBinder
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import com.anchormobile.R

class SunsetOverlayService : Service() {
    private var overlay: View? = null
    private var windowManager: WindowManager? = null

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        if (Build.VERSION.SDK_INT >= 26) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.channel_sunset_overlay), NotificationManager.IMPORTANCE_LOW))
        }
        startForeground(NOTIFICATION_ID, notification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.getStringExtra(EXTRA_PHASE)) {
            null, "off" -> stopSelf()
            else -> showOverlay(intent.getStringExtra(EXTRA_PHASE) ?: "T60")
        }
        return START_STICKY
    }

    private fun showOverlay(phase: String) {
        val alpha = when (phase) {
            "T60" -> 0.10f
            "T30" -> 0.22f
            "T15" -> 0.36f
            else -> 0f
        }
        if (alpha == 0f) {
            removeOverlay()
            return
        }
        val view = overlay ?: View(this).also {
            it.setBackgroundColor(Color.BLACK)
            it.isClickable = false
            it.isFocusable = false
            overlay = it
            val type = if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE
            val params = WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT,
            ).apply { gravity = Gravity.TOP or Gravity.START }
            it.alpha = alpha
            windowManager?.addView(it, params)
        }
        view.alpha = alpha
    }

    private fun removeOverlay() {
        overlay?.let { windowManager?.removeView(it) }
        overlay = null
    }

    private fun notification(): Notification = android.app.Notification.Builder(this, CHANNEL)
        .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
        .setContentTitle(getString(R.string.svc_overlay_title))
        .setContentText(getString(R.string.svc_overlay_phase_format, AnchorRuntime.state.value.sunsetPhase))
        .setOngoing(true)
        .build()

    override fun onDestroy() {
        removeOverlay()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val EXTRA_PHASE = "phase"
        private const val CHANNEL = "anchor-sunset-overlay"
        private const val NOTIFICATION_ID = 4102

        fun apply(context: android.content.Context, phase: String) {
            val intent = Intent(context, SunsetOverlayService::class.java).putExtra(EXTRA_PHASE, phase)
            if (phase == "off") context.stopService(intent)
            else if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }
    }
}
