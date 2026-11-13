package com.anchormobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import com.anchormobile.ui.AnchorTheme
import com.anchormobile.ui.PromptInputScreen

/**
 * 睡前意图输入界面（通用 PromptInputScreen 装配）。
 *
 * 三种模式（intent extra "mode"）：
 * - capture（默认）：通知/重开入口拉起。60s 未输入自动跳过（auto_skip 上报，
 *   输入即取消倒计时）；任一端响应后服务器广播 dismiss，本界面观察到状态失效即 finish；
 *   输入中（userTyped）收到其他端 dismiss/接管广播不关闭，提交/跳过永远有效。
 * - modify：晨间确认时修改意图，预填现有内容，无倒计时，source=wakeup。
 * - manual：首页「写睡前意图」手动拉起，无倒计时，source=system。
 */
class IntentCaptureActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val mode = intent.getStringExtra("mode") ?: "capture"
        val prefill = intent.getStringExtra("prefill") ?: ""
        val modifyDate = intent.getStringExtra("date")

        setContent {
            AnchorTheme {
                val state by AnchorRuntime.state.collectAsState()
                val capture = state.intentCapture

                // capture 模式必须有捕获状态（通知刚到达时状态已就位）；modify/manual 无依赖
                if (mode == "capture" && capture == null) {
                    LaunchedEffect(Unit) { finish() }
                    return@AnchorTheme
                }

                val initialPromptId = remember { capture?.promptId ?: "" }
                val source = when (mode) {
                    "modify" -> "wakeup"
                    "manual" -> "system"
                    else -> "bedtime"
                }
                var userTyped by remember { mutableStateOf(false) }
                val latestTyped by rememberUpdatedState(userTyped)

                // 跨端联动关闭：其他端已响应/服务器兜底到期（promptId 变化或状态清空）；
                // 已输入（接管中）则不关闭，提交/跳过永远有效
                LaunchedEffect(capture) {
                    if (mode != "capture") return@LaunchedEffect
                    if ((capture == null || capture.promptId != initialPromptId) && !latestTyped) finish()
                }

                // skip/空提交语义：capture 模式有活跃捕获时上报 skip（全端关弹窗，重开入口保留）
                fun skip() {
                    if (mode == "capture" && initialPromptId.isNotEmpty()) {
                        AnchorRuntime.captureResponse(initialPromptId, "skip")
                    }
                    finish()
                }

                PromptInputScreen(
                    title       = stringResource(if (mode == "modify") R.string.intent_modify_title else R.string.intent_capture_title),
                    body        = when (mode) {
                        "modify" -> stringResource(R.string.intent_modify_body)
                        "manual" -> stringResource(R.string.intent_manual_body)
                        else     -> capture?.prompt ?: ""
                    },
                    placeholder = stringResource(R.string.intent_capture_placeholder),
                    prefill     = prefill,
                    submitLabel = stringResource(R.string.intent_capture_btn_submit),
                    skipLabel   = stringResource(if (mode == "capture") R.string.intent_capture_btn_later else R.string.intent_modify_btn_cancel),
                    countdownSeconds = if (mode == "capture") capture?.timeoutSeconds ?: 60 else null,
                    countdownHint = { stringResource(R.string.intent_capture_countdown_format, it) },
                    onInputStarted = {
                        if (!userTyped) {
                            userTyped = true
                            AnchorRuntime.notifyIntentTyping(initialPromptId)
                        }
                    },
                    onTimeout = {
                        // 本地重开（promptId 空）超时仅关闭，不上报
                        if (initialPromptId.isNotEmpty()) {
                            AnchorRuntime.captureResponse(initialPromptId, "auto_skip")
                        }
                        finish()
                    },
                    onSubmit = { value ->
                        if (value.isEmpty()) {
                            skip()
                        } else {
                            AnchorRuntime.submitIntent(
                                value,
                                source,
                                date = if (mode == "modify") modifyDate else null,
                                promptId = if (mode == "capture") initialPromptId.ifEmpty { null } else null,
                            )
                            finish()
                        }
                    },
                    onSkip = { skip() },
                )
            }
        }
    }
}
