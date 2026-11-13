package com.anchormobile

import android.content.Context
import android.app.Application
import androidx.annotation.StringRes
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.anchormobile.R
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.util.Locale

fun userStateLabel(context: Context, userState: String?): String = context.getString(
    when (userState) {
        "working" -> R.string.state_working
        "entertaining" -> R.string.state_entertaining
        "dissociating" -> R.string.state_dissociating
        "resting" -> R.string.state_resting
        "sleeping" -> R.string.state_sleeping
        "away" -> R.string.state_away
        else -> R.string.state_unknown
    }
)

/** 睡前意图捕获状态；promptId 空串 = 本地重开（服务器活跃捕获已结束），超时仅本地关闭 */
data class IntentCaptureState(
    val promptId: String,
    val prompt: String,
    val timeoutSeconds: Int,
)

/** 待确认的昨日意图（起床后展示） */
data class IntentConfirmState(
    val date: String,
    val content: String,
)

data class AnchorUiState(
    val tab: Int = 0,
    val connected: Boolean = false,
    val serviceRunning: Boolean = false,
    val userState: String? = null,
    val sunsetPhase: String = "off",
    val bedtimeMinutes: Int = 90,
    val aiMessage: String? = null,
    val interventionMessage: String? = null,
    val interventionId: String? = null,
    val interventionLevel: String? = null,
    val interventionAction: String? = null,
    val detectedApp: String? = null,
    val environmentZone: String? = null,
    val screenColorTemp: Int? = null,
    val capsuleContent: String? = null,
    val capsuleTrigger: String? = null,
    val aiResponse: String? = null,
    /** 睡前意图捕获；非 null 时通知栏常驻重开入口（answered 后清空） */
    val intentCapture: IntentCaptureState? = null,
    /** 待确认昨日意图（起床验证后展示） */
    val intentConfirm: IntentConfirmState? = null,
    val lastTimeAnchor: String? = null,
    val lastSuggestion: String? = null,
    val lastWakeupAlarmAt: Long? = null,
    /** 入睡确认窗口截止时刻（Unix 秒）；null = 无确认请求，确认框随之销毁 */
    val sleepConfirmUntil: Long? = null,
    /** 状态切换弹窗 prompt id；null = 无活跃弹窗，弹窗随之销毁（跨端联动关闭） */
    val contextSwitchPromptId: String? = null,
    val contextSwitchPlaceholder: String? = null,
    /** 自动跳过截止时刻（Unix 秒）；输入后倒计时取消，不再生效 */
    val contextSwitchDeadline: Long = 0,
    /** 服务器返回的配置错误信息；非 null 时禁用发送并显示错误状态 */
    val configError: String? = null,
    /** 昨晚写的今日意图（GET /api/intentions?date=yesterday），供首页卡片展示 */
    val yesterdayIntention: String? = null,
    /** 今日写的明日意图（GET /api/intentions?date=today），供写意图入口预填 */
    val todayIntention: String? = null,
) {
    @get:StringRes
    val stateLabelRes: Int get() = when (userState) {
        "working" -> R.string.state_working
        "entertaining" -> R.string.state_entertaining
        "dissociating" -> R.string.state_dissociating
        "resting" -> R.string.state_resting
        "sleeping" -> R.string.state_sleeping
        "away" -> R.string.state_away
        else -> R.string.state_unknown
    }
    val bedtimeLabel: String get() = String.format(Locale.US, "%02d:%02d", bedtimeMinutes / 60, bedtimeMinutes % 60)
}

class AnchorViewModel(application: Application) : AndroidViewModel(application) {
    val state: StateFlow<AnchorUiState> = AnchorRuntime.state
    fun selectTab(tab: Int) { AnchorRuntime.setTab(tab) }
    fun send(message: Map<String, Any?>) { AnchorRuntime.send(message) }
    fun sendCircadian(event: String) {
        viewModelScope.launch { AnchorRuntime.postCircadian(event) }
    }
}
