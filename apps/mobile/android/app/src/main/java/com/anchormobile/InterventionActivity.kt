package com.anchormobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
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

class InterventionActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            AnchorTheme {
                val state by AnchorRuntime.state.collectAsState()
                // 根据 interventionLevel 决定语义颜色，无值时默认强干预橙色
                val levelColor = InterventionColor.forLevel(state.interventionLevel)

                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(MaterialTheme.colorScheme.background)
                        .padding(0.dp),
                    verticalArrangement = Arrangement.Center,
                ) {
                    // 顶部语义色条（4dp 左边框 + 整行色带）
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(MaterialTheme.colorScheme.surfaceVariant)
                            .padding(vertical = 16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        // 4dp 左侧语义色竖条
                        Box(
                            modifier = Modifier
                                .width(4.dp)
                                .height(56.dp)
                                .background(levelColor)
                        )
                        Spacer(Modifier.width(16.dp))
                        Column {
                            Text(
                                text       = stringResource(R.string.intervention_title),
                                fontSize   = 18.sp,
                                fontWeight = FontWeight.SemiBold,
                                color      = MaterialTheme.colorScheme.onSurface,
                            )
                            Text(
                                text     = state.interventionMessage ?: stringResource(R.string.intervention_default),
                                fontSize = 14.sp,
                                color    = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(top = 4.dp),
                            )
                            state.detectedApp?.let {
                                Text(
                                    text     = stringResource(R.string.intervention_detected_format, it),
                                    fontSize = 13.sp,
                                    color    = levelColor,
                                    modifier = Modifier.padding(top = 4.dp),
                                )
                            }
                        }
                    }

                    // 操作按钮区
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 24.dp, vertical = 24.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        // Primary：回去工作
                        Button(
                            onClick        = { AnchorRuntime.respondToIntervention("accepted"); finish() },
                            modifier       = Modifier.fillMaxWidth().height(40.dp),
                            shape          = RoundedCornerShape(6.dp),
                            contentPadding = PaddingValues(horizontal = 12.dp),
                            colors         = ButtonDefaults.buttonColors(
                                containerColor = MaterialTheme.colorScheme.primary,
                            ),
                        ) {
                            Text(stringResource(R.string.intervention_btn_accept), fontSize = 14.sp)
                        }
                        // Secondary：我在休息
                        OutlinedButton(
                            onClick        = { AnchorRuntime.respondToIntervention("rejected"); finish() },
                            modifier       = Modifier.fillMaxWidth().height(40.dp),
                            shape          = RoundedCornerShape(6.dp),
                            contentPadding = PaddingValues(horizontal = 12.dp),
                        ) {
                            Text(stringResource(R.string.intervention_btn_reject), fontSize = 14.sp)
                        }
                    }
                }
            }
        }
    }
}
