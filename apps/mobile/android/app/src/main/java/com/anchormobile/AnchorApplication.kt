package com.anchormobile

import android.app.Application
import android.os.Environment
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class AnchorApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        installCrashHandler()
    }

    /** 全局未捕获异常处理器：写崩溃日志到 filesDir/crash.log，防止无障碍服务崩溃后无法排查 */
    private fun installCrashHandler() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                val file = File(filesDir, "crash.log")
                val timestamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date())
                val sb = StringBuilder()
                sb.append("=== ").append(timestamp).append(" [").append(thread.name).append("] ===\n")
                sb.append(throwable.toString()).append("\n")
                throwable.stackTrace.take(20).forEach { sb.append("    at ").append(it).append("\n") }
                sb.append("\n")
                FileOutputStream(file, true).use { it.write(sb.toString().toByteArray(Charsets.UTF_8)) }
            } catch (_: Exception) {
            }
            // 交给原处理器结束进程，保证行为不变
            previous?.uncaughtException(thread, throwable)
        }
    }
}
