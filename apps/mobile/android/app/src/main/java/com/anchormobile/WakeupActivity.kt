package com.anchormobile

import android.content.Intent
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.res.stringResource
import com.anchormobile.R
import com.anchormobile.ui.AnchorTheme
import kotlin.math.abs
import kotlin.math.sqrt
import kotlinx.coroutines.delay

class WakeupActivity : ComponentActivity(), SensorEventListener {
    private lateinit var sensorManager: SensorManager

    // 摇动检测参数
    private var lastAccel = FloatArray(3) { 0f }  // 上次加速度向量
    private var lastShakeTime = 0L                // 上次摇动时间戳
    private var lastCountTime = 0L                // 上次计数时间戳（防抖）
    private var lastDirection = 0                 // 上次摇动方向 (1/-1/0)

    // 摇动计数状态 - Compose 可观察
    private var shakeCount by mutableIntStateOf(0)

    // 起床验证完成：切换到昨日意图确认步
    private var verified by mutableStateOf(false)
    
    companion object {
        const val REQUIRED_SHAKES = 5           // 需要5次摇动
        const val SHAKE_THRESHOLD = 30f         // 加速度变化阈值（非常严格）
        const val DIRECTION_THRESHOLD = 5f      // 方向判断阈值（X轴变化必须够大）
        const val SHAKE_TIMEOUT = 3000L         // 摇动超时3秒重置
        const val DEBOUNCE_INTERVAL = 400L      // 防抖间隔400ms
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sensorManager = getSystemService(SENSOR_SERVICE) as SensorManager
        sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME)
        }
        setContent {
            AnchorTheme {
                if (verified) {
                    IntentConfirmStep(
                        onDone = { finish() },
                        onModify = { confirm ->
                            startActivity(Intent(this, IntentCaptureActivity::class.java).apply {
                                putExtra("mode", "modify")
                                putExtra("prefill", confirm.content)
                                putExtra("date", confirm.date)
                            })
                            finish()
                        },
                    )
                    return@AnchorTheme
                }
                val accent = MaterialTheme.colorScheme.primary
                val trackColor = MaterialTheme.colorScheme.outline

                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(MaterialTheme.colorScheme.background)
                        .padding(horizontal = 32.dp, vertical = 48.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text(
                        text       = stringResource(R.string.wakeup_title),
                        fontSize   = 20.sp,
                        fontWeight = FontWeight.SemiBold,
                        color      = MaterialTheme.colorScheme.onBackground,
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text     = stringResource(R.string.wakeup_instruction),
                        fontSize = 14.sp,
                        color    = MaterialTheme.colorScheme.secondary,
                    )
                    Spacer(Modifier.height(28.dp))

                    // 五条独立进度条，每次来回摇动填满一条
                    Column(
                        modifier = Modifier.widthIn(max = 280.dp).fillMaxWidth(),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        repeat(REQUIRED_SHAKES) { index ->
                            val filled = shakeCount > index
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                LinearProgressIndicator(
                                    progress         = { if (filled) 1f else 0f },
                                    modifier         = Modifier
                                        .weight(1f)
                                        .height(6.dp),
                                    color            = accent,
                                    trackColor       = trackColor,
                                    strokeCap        = StrokeCap.Round,
                                )
                            }
                        }
                    }

                    Spacer(Modifier.height(8.dp))
                    Text(
                        text     = stringResource(R.string.wakeup_progress_format, shakeCount, REQUIRED_SHAKES),
                        fontSize = 13.sp,
                        color    = MaterialTheme.colorScheme.secondary,
                    )
                    Spacer(Modifier.height(32.dp))

                    // 主操作按钮（Primary 样式）
                    Button(
                        onClick        = { verify() },
                        modifier       = Modifier.fillMaxWidth().height(36.dp),
                        shape          = RoundedCornerShape(6.dp),
                        contentPadding = PaddingValues(horizontal = 12.dp),
                        colors         = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.primary,
                            contentColor   = MaterialTheme.colorScheme.onPrimary,
                        ),
                    ) {
                        Text(stringResource(R.string.wakeup_btn_done), fontSize = 14.sp)
                    }
                }
            }
        }
    }

    override fun onSensorChanged(event: SensorEvent) {
        val currentTime = System.currentTimeMillis()
        
        // 检查超时重置
        if (currentTime - lastShakeTime > SHAKE_TIMEOUT && shakeCount > 0) {
            shakeCount = 0
            lastDirection = 0
            lastCountTime = 0L
        }
        
        // 计算加速度变化幅度
        val deltaX = event.values[0] - lastAccel[0]
        val deltaY = event.values[1] - lastAccel[1]
        val deltaZ = event.values[2] - lastAccel[2]
        val deltaAccel = sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ)
        
        // 检测到足够剧烈的摇动
        if (deltaAccel > SHAKE_THRESHOLD) {
            // X 轴变化必须足够明显才算有效方向
            if (abs(deltaX) > DIRECTION_THRESHOLD) {
                val currentDirection = if (deltaX > 0) 1 else -1
                
                // 必须满足：1) 方向反转 2) 距离上次计数超过防抖间隔
                if (lastDirection != 0 && 
                    currentDirection != lastDirection &&
                    currentTime - lastCountTime >= DEBOUNCE_INTERVAL) {
                    
                    shakeCount = (shakeCount + 1).coerceAtMost(REQUIRED_SHAKES)
                    lastShakeTime = currentTime
                    lastCountTime = currentTime  // 记录本次计数时间
                    
                    // 达到要求次数自动验证
                    if (shakeCount >= REQUIRED_SHAKES) {
                        verify()
                    }
                }
                
                lastDirection = currentDirection
            }
        }
        
        // 更新加速度记录
        lastAccel[0] = event.values[0]
        lastAccel[1] = event.values[1]
        lastAccel[2] = event.values[2]
    }

    private fun verify() {
        sensorManager.unregisterListener(this)
        AnchorRuntime.reportWakeupVerified()
        // 不直接 finish：进入昨日意图确认步（无昨日意图时 2s 后自动关闭）
        verified = true
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
    override fun onDestroy() { sensorManager.unregisterListener(this); super.onDestroy() }
}

/**
 * 起床验证后的昨日意图确认步：展示昨晚记录的意图，可确认或修改。
 * 服务器在 wakeup:verified 后广播 intent:confirm，2s 内未到达（无昨日意图）自动关闭。
 */
@androidx.compose.runtime.Composable
private fun IntentConfirmStep(onDone: () -> Unit, onModify: (IntentConfirmState) -> Unit) {
    val state by AnchorRuntime.state.collectAsState()
    val confirm = state.intentConfirm

    LaunchedEffect(confirm) {
        if (confirm != null) return@LaunchedEffect
        delay(2000)
        onDone()
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(horizontal = 32.dp, vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text       = stringResource(R.string.intent_confirm_title),
            fontSize   = 20.sp,
            fontWeight = FontWeight.SemiBold,
            color      = MaterialTheme.colorScheme.onBackground,
        )
        Spacer(Modifier.height(12.dp))
        Text(
            text     = confirm?.content ?: "",
            fontSize = 15.sp,
            color    = MaterialTheme.colorScheme.onSurface,
        )
        Spacer(Modifier.height(32.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(
                onClick        = { confirm?.let(onModify) },
                enabled        = confirm != null,
                modifier       = Modifier.height(36.dp),
                shape          = RoundedCornerShape(6.dp),
                contentPadding = PaddingValues(horizontal = 16.dp),
            ) {
                Text(stringResource(R.string.intent_confirm_btn_modify), fontSize = 14.sp)
            }
            Button(
                onClick        = { confirm?.let { AnchorRuntime.confirmIntent(it.date) }; onDone() },
                enabled        = confirm != null,
                modifier       = Modifier.height(36.dp),
                shape          = RoundedCornerShape(6.dp),
                contentPadding = PaddingValues(horizontal = 16.dp),
                colors         = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor   = MaterialTheme.colorScheme.onPrimary,
                ),
            ) {
                Text(stringResource(R.string.intent_confirm_btn_confirm), fontSize = 14.sp)
            }
        }
    }
}
