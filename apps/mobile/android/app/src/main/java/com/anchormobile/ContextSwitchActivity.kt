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
 * 状态切换弹窗（注意力残留采集）：工作 → 非工作时由服务器广播拉起。
 * 任一端响应后服务器广播 dismiss，本 Activity 观察到 promptId 置空即 finish；
 * 15s 内未输入自动跳过，一旦输入即取消倒计时，只能手动提交/跳过。
 * 输入中（userTyped）收到其他端 dismiss/接管广播不关闭，提交/跳过永远有效。
 */
class ContextSwitchActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            AnchorTheme {
                val state by AnchorRuntime.state.collectAsState()
                var userTyped by remember { mutableStateOf(false) }
                val latestTyped by rememberUpdatedState(userTyped)

                // 跨端联动关闭：其他端已响应/服务器兜底到期；已输入（接管中）则不关闭
                LaunchedEffect(state.contextSwitchPromptId) {
                    if (state.contextSwitchPromptId == null && !latestTyped) finish()
                }

                PromptInputScreen(
                    title       = stringResource(R.string.context_switch_title),
                    body        = stringResource(R.string.context_switch_body),
                    placeholder = state.contextSwitchPlaceholder ?: "",
                    submitLabel = stringResource(R.string.context_switch_btn_submit),
                    skipLabel   = stringResource(R.string.context_switch_btn_skip),
                    countdownSeconds = (state.contextSwitchDeadline - System.currentTimeMillis() / 1000).toInt().coerceAtLeast(1),
                    countdownHint = { stringResource(R.string.context_switch_countdown_format, it) },
                    onInputStarted = {
                        if (!userTyped) {
                            userTyped = true
                            AnchorRuntime.notifyContextSwitchTyping()
                        }
                    },
                    onTimeout = {
                        AnchorRuntime.respondContextSwitch(this@ContextSwitchActivity, "auto_skip", null)
                        finish()
                    },
                    onSubmit = { value ->
                        if (value.isEmpty()) {
                            AnchorRuntime.respondContextSwitch(this@ContextSwitchActivity, "skip", null)
                        } else {
                            AnchorRuntime.respondContextSwitch(this@ContextSwitchActivity, "submit", value)
                        }
                        finish()
                    },
                    onSkip = {
                        AnchorRuntime.respondContextSwitch(this@ContextSwitchActivity, "skip", null)
                        finish()
                    },
                )
            }
        }
    }
}
