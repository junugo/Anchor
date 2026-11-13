package com.anchormobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

/**
 * 通用计时输入屏（状态切换 / 睡前意图共用模板）。
 *
 * 语义与各弹窗一致：
 * - countdownSeconds 非空时显示倒计时，未输入到期触发 onTimeout；
 *   一旦输入（或预填非空）倒计时停止，只能手动提交/稍后
 * - onSubmit 参数为 trim 后文本（空串语义由调用方决定，通常按稍后处理）
 */
@Composable
fun PromptInputScreen(
    title: String,
    body: String,
    placeholder: String,
    submitLabel: String,
    skipLabel: String,
    onSubmit: (String) -> Unit,
    onSkip: () -> Unit,
    prefill: String = "",
    countdownSeconds: Int? = null,
    countdownHint: @Composable (Int) -> String = { "" },
    onTimeout: () -> Unit = {},
    /** 首次输入时触发一次（跨端接管信号；预填非空时不触发） */
    onInputStarted: () -> Unit = {},
) {
    var text by remember { mutableStateOf(prefill) }
    var typing by remember { mutableStateOf(prefill.isNotEmpty()) }
    var remaining by remember { mutableIntStateOf(countdownSeconds ?: 0) }

    // 倒计时：仅未输入时生效；输入即取消
    LaunchedEffect(typing) {
        if (countdownSeconds == null || typing) return@LaunchedEffect
        while (remaining > 0) {
            delay(1000)
            remaining -= 1
        }
        onTimeout()
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text       = title,
            fontSize   = 18.sp,
            fontWeight = FontWeight.SemiBold,
            color      = MaterialTheme.colorScheme.onSurface,
        )
        Text(
            text     = body,
            fontSize = 14.sp,
            color    = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 8.dp),
        )

        OutlinedTextField(
            value         = text,
            onValueChange = { value ->
                if (!typing) {
                    typing = true
                    onInputStarted()
                }
                text = value
            },
            placeholder   = { Text(placeholder) },
            modifier      = Modifier
                .fillMaxWidth()
                .padding(top = 16.dp),
            minLines = 3,
        )

        Text(
            text     = if (countdownSeconds != null && !typing && remaining > 0) countdownHint(remaining) else "",
            fontSize = 12.sp,
            color    = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 8.dp),
        )

        Row(
            modifier              = Modifier
                .fillMaxWidth()
                .padding(top = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.End),
        ) {
            OutlinedButton(
                onClick        = onSkip,
                modifier       = Modifier.height(40.dp),
                shape          = RoundedCornerShape(6.dp),
                contentPadding = PaddingValues(horizontal = 16.dp),
            ) {
                Text(skipLabel, fontSize = 14.sp)
            }
            Button(
                onClick        = { onSubmit(text.trim()) },
                modifier       = Modifier.height(40.dp),
                shape          = RoundedCornerShape(6.dp),
                contentPadding = PaddingValues(horizontal = 16.dp),
                colors         = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                ),
            ) {
                Text(submitLabel, fontSize = 14.sp)
            }
        }
    }
}
