package com.anchormobile

import android.os.Bundle
import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.res.stringResource
import com.anchormobile.R
import com.anchormobile.ui.AnchorTheme
import com.anchormobile.ui.InterventionColor
import kotlinx.coroutines.delay

class CurfewActivity : ComponentActivity() {
    override fun onBackPressed() = Unit
    override fun onCreate(savedInstanceState: Bundle?) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NO_HISTORY or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        super.onCreate(savedInstanceState)
        setContent {
            AnchorTheme {
                val curfewRed = InterventionColor.Curfew
                val uiState by AnchorRuntime.state.collectAsState()

                // 宵禁解除（服务器 off / 本地过期 / 破戒 / 起床验证）时自动关闭
                LaunchedEffect(uiState.sunsetPhase) {
                    if (uiState.sunsetPhase == "off") finish()
                }

                // 所有按钮 1500ms 后一起渐显，先让红屏完整展示
                var showButton by remember { mutableStateOf(false) }
                var showReleaseDialog by remember { mutableStateOf(false) }
                var releaseReason by remember { mutableStateOf("") }
                LaunchedEffect(Unit) {
                    delay(1500L)
                    showButton = true
                }

                // 强制解锁原因输入对话框
                if (showReleaseDialog) {
                    androidx.compose.material3.AlertDialog(
                        onDismissRequest = { showReleaseDialog = false },
                        title = { Text(stringResource(R.string.sunset_release_dialog_title)) },
                        text = {
                            androidx.compose.material3.OutlinedTextField(
                                value = releaseReason,
                                onValueChange = { releaseReason = it },
                                placeholder = { Text(stringResource(R.string.sunset_release_dialog_hint)) },
                                singleLine = true,
                            )
                        },
                        confirmButton = {
                            Button(
                                onClick = {
                                    AnchorRuntime.send(mapOf("type" to "sunset:release", "reason" to releaseReason.trim()))
                                    showReleaseDialog = false
                                },
                                enabled = releaseReason.isNotBlank(),
                            ) {
                                Text(stringResource(R.string.sunset_release_dialog_confirm))
                            }
                        },
                        dismissButton = {
                            OutlinedButton(onClick = { showReleaseDialog = false }) {
                                Text(stringResource(R.string.common_cancel))
                            }
                        },
                    )
                }

                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(curfewRed),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(
                        modifier = Modifier
                            .widthIn(max = 320.dp)
                            .padding(horizontal = 32.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(
                            text       = stringResource(R.string.curfew_title),
                            fontSize   = 24.sp,
                            fontWeight = FontWeight.SemiBold,
                            color      = Color.White,
                        )
                        Text(
                            text  = stringResource(R.string.curfew_subtitle),
                            fontSize = 15.sp,
                            color = Color.White.copy(alpha = 0.70f),
                        )
                        Spacer(Modifier.height(20.dp))
                        AnimatedVisibility(
                            visible = showButton,
                            enter   = fadeIn(),
                        ) {
                            Column(
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                // 起床验证入口：Anchor 本 App 不被宵禁守护拦截，
                                // 验证通过后服务器广播 off，本页随状态观察自动关闭
                                Button(
                                    onClick        = { startActivity(Intent(this@CurfewActivity, WakeupActivity::class.java)) },
                                    shape          = RoundedCornerShape(6.dp),
                                    contentPadding = PaddingValues(horizontal = 20.dp),
                                    colors         = ButtonDefaults.buttonColors(
                                        containerColor = Color.White,
                                        contentColor   = curfewRed,
                                    ),
                                ) {
                                    Text(stringResource(R.string.curfew_btn_wakeup), fontSize = 14.sp)
                                }
                                // 强制解除：输入原因 → sunset:release，服务器广播 off 后本页随状态观察自动关闭
                                OutlinedButton(
                                    onClick        = { showReleaseDialog = true },
                                    shape          = RoundedCornerShape(6.dp),
                                    contentPadding = PaddingValues(horizontal = 20.dp),
                                    colors         = ButtonDefaults.outlinedButtonColors(
                                        contentColor = Color.White,
                                    ),
                                    border         = BorderStroke(1.dp, Color.White.copy(alpha = 0.60f)),
                                ) {
                                    Text(stringResource(R.string.curfew_btn_unlock), fontSize = 14.sp)
                                }
                                // 返回 Anchor 主页面：Anchor 自身不受宵禁限制
                                OutlinedButton(
                                    onClick        = {
                                        startActivity(Intent(this@CurfewActivity, MainActivity::class.java))
                                        finish()
                                    },
                                    shape          = RoundedCornerShape(6.dp),
                                    contentPadding = PaddingValues(horizontal = 20.dp),
                                    colors         = ButtonDefaults.outlinedButtonColors(
                                        contentColor = Color.White,
                                    ),
                                    border         = BorderStroke(1.dp, Color.White.copy(alpha = 0.60f)),
                                ) {
                                    Text(stringResource(R.string.curfew_btn_back), fontSize = 14.sp)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}


