package com.anchormobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.res.stringResource
import com.anchormobile.R
import com.anchormobile.ui.AnchorTheme
import com.anchormobile.ui.InterventionColor

/**
 * 入睡确认页：服务器怀疑用户已睡着时全屏弹出。
 * 只有「还没睡」一个按钮——能点击即证明醒着；
 * 无响应则由服务器超时自动确认睡着（广播 sleep:confirm-cancel 驱动本页销毁）。
 */
class SleepConfirmActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            AnchorTheme {
                val uiState by AnchorRuntime.state.collectAsState()

                // 服务器取消确认（超时/他端已响应）→ 本页销毁
                LaunchedEffect(uiState.sleepConfirmUntil) {
                    if (uiState.sleepConfirmUntil == null) finish()
                }

                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(InterventionColor.Curfew)
                        .padding(horizontal = 32.dp, vertical = 48.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text(
                        text       = stringResource(R.string.sleep_confirm_title),
                        fontSize   = 22.sp,
                        fontWeight = FontWeight.SemiBold,
                        color      = MaterialTheme.colorScheme.onPrimary,
                    )
                    Spacer(Modifier.height(12.dp))
                    Text(
                        text     = stringResource(R.string.sleep_confirm_body),
                        fontSize = 14.sp,
                        color    = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.72f),
                    )
                    Spacer(Modifier.height(36.dp))
                    Button(
                        onClick = {
                            AnchorRuntime.send(mapOf("type" to "sleep:confirm-response", "confirmed" to false))
                            finish()
                        },
                        modifier       = Modifier.widthIn(max = 280.dp).fillMaxWidth().height(40.dp),
                        shape          = RoundedCornerShape(6.dp),
                        contentPadding = PaddingValues(horizontal = 16.dp),
                        colors         = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.onPrimary,
                            contentColor   = InterventionColor.Curfew,
                        ),
                    ) {
                        Text(stringResource(R.string.sleep_confirm_btn_notyet), fontSize = 15.sp)
                    }
                }
            }
        }
    }
}
