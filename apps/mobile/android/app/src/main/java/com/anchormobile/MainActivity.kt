package com.anchormobile

import android.content.Intent
import android.app.AppOpsManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Process
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imeAnimationTarget
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material.icons.filled.Security
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.anchormobile.R
import com.anchormobile.ui.AnchorTheme
import com.anchormobile.ui.InterventionColor
import kotlinx.coroutines.launch

// 首页 Activity 入口

class MainActivity : ComponentActivity() {
    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // adb 调试时通过 Intent extra 传入服务器地址
        // adb shell am start -n com.anchormobile/.MainActivity --es server_url http://x.x.x.x:4000
        intent.getStringExtra("server_url")?.let { url ->
            getSharedPreferences("anchor", android.content.Context.MODE_PRIVATE)
                .edit().putString("server_url", url).apply()
        }
        AnchorService.start(this)
        if (Build.VERSION.SDK_INT >= 33)
            notificationPermission.launch("android.permission.POST_NOTIFICATIONS")

        setContent {
            AnchorTheme {
                val model: AnchorViewModel = viewModel()
                val state by model.state.collectAsState()
                AnchorScaffold(state, model)
            }
        }
    }
}

// 导航栏结构

private data class NavItem(val icon: ImageVector, val labelResId: Int)

private val NAV_ITEMS = listOf(
    NavItem(Icons.Default.BarChart,    R.string.nav_dashboard),
    NavItem(Icons.Default.Forum,       R.string.nav_chat),
    NavItem(Icons.Default.Apps,        R.string.nav_apps),
    NavItem(Icons.Default.Settings,    R.string.nav_settings),
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AnchorScaffold(state: AnchorUiState, model: AnchorViewModel) {
    val accent    = MaterialTheme.colorScheme.primary
    val secondary = MaterialTheme.colorScheme.secondary

    val density = LocalDensity.current
    // 用动画目标状态判断：键盘开始收起瞬间 target 即归零，Dock 立刻显示，不等降下动画结束
    val imeVisible = WindowInsets.imeAnimationTarget.getBottom(density) > 0
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = {
            // 键盘弹出时隐藏底部 Dock，让聊天输入框正好贴在键盘上方
            if (!imeVisible) {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surface, tonalElevation = 0.dp) {
                NAV_ITEMS.forEachIndexed { index, item ->
                    val selected = state.tab == index
                    val label = stringResource(item.labelResId)
                    NavigationBarItem(
                        selected = selected,
                        onClick  = { model.selectTab(index) },
                        icon = {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Icon(item.icon, contentDescription = label, modifier = Modifier.size(20.dp))
                                if (selected) { Spacer(Modifier.height(3.dp)); Canvas(Modifier.size(4.dp)) { drawCircle(color = accent) } }
                                else Spacer(Modifier.height(7.dp))
                            }
                        },
                        label  = null,
                        colors = NavigationBarItemDefaults.colors(selectedIconColor = accent, unselectedIconColor = secondary, indicatorColor = Color.Transparent),
                    )
                }
            }
            }
        },
    ) { padding ->
        when (state.tab) {
            1    -> ChatScreen(modifier = Modifier.padding(padding), vm = viewModel())
            2    -> AppsScreen(Modifier.padding(padding))
            3    -> SettingsPanel(state, model, Modifier.padding(padding))
            else -> HomePanel(state, model, Modifier.padding(padding))
        }
    }
}

// 卡片组件

@Composable
private fun AnchorCard(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Card(
        modifier  = modifier.fillMaxWidth(),
        shape     = RoundedCornerShape(8.dp),
        colors    = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border    = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
        elevation = CardDefaults.cardElevation(0.dp),
    ) { Box(Modifier.padding(horizontal = 20.dp, vertical = 16.dp)) { content() } }
}

@Composable
private fun PrimaryButton(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Button(onClick = onClick, modifier = modifier.height(36.dp), shape = RoundedCornerShape(6.dp), contentPadding = PaddingValues(horizontal = 12.dp)) {
        Text(label, fontSize = 14.sp)
    }
}

@Composable
private fun SecondaryButton(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, modifier = modifier.height(36.dp), shape = RoundedCornerShape(6.dp), contentPadding = PaddingValues(horizontal = 12.dp)) {
        Text(label, fontSize = 14.sp)
    }
}

// 仪表盘面板

@Composable
private fun HomePanel(state: AnchorUiState, model: AnchorViewModel, modifier: Modifier) {
    val context = LocalContext.current
    val stateColor = InterventionColor.forState(state.userState)
    var confirmEvent by remember { mutableStateOf<String?>(null) }

    // 生命周期：回到前台时刷新意图（写意图返回 / 跨天回来后卡片即时更新）
    val lifecycleOwner = LocalLifecycleOwner.current
    var refreshKey by remember { mutableIntStateOf(0) }
    LaunchedEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) refreshKey++
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        kotlinx.coroutines.awaitCancellation()
        lifecycleOwner.lifecycle.removeObserver(observer)
    }

    // 前台停留期间每 5 分钟周期刷新，避免跨午夜后显示前日意图
    LaunchedEffect(refreshKey) {
        while (true) {
            AnchorRuntime.fetchIntentions(context)
            kotlinx.coroutines.delay(5 * 60 * 1000L)
        }
    }

    Column(
        modifier = modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.common_app_name_title), fontSize = 18.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onBackground)
            Text(if (state.connected) stringResource(R.string.common_connected) else stringResource(R.string.common_disconnected), fontSize = 12.sp, fontWeight = FontWeight.Medium, color = if (state.connected) InterventionColor.passive else MaterialTheme.colorScheme.secondary)
        }
        AnchorCard {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.home_current_state), fontSize = 12.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.secondary)
                Text(stringResource(state.stateLabelRes), fontSize = 22.sp, fontWeight = FontWeight.SemiBold, color = stateColor)
                Text(stringResource(R.string.home_service_status_format, if (state.serviceRunning) stringResource(R.string.common_running) else stringResource(R.string.common_not_started)), fontSize = 13.sp, color = MaterialTheme.colorScheme.secondary)
            }
        }
        if (state.aiMessage != null) {
            AnchorCard {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(stringResource(R.string.home_anchor_says), fontSize = 12.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.secondary)
                    Text(state.aiMessage, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurface)
                }
            }
        }
        // 今日意图卡片（昨晚写的，纯展示）+ 写今日意图按钮
        val yesterdayIntention = state.yesterdayIntention
        AnchorCard {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.home_intention_title), fontSize = 12.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.secondary)
                if (yesterdayIntention != null) {
                    Text(yesterdayIntention, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurface)
                } else {
                    Text(stringResource(R.string.home_intention_empty), fontSize = 13.sp, color = MaterialTheme.colorScheme.secondary)
                }
                PrimaryButton(stringResource(R.string.home_intention_btn_write)) {
                    AnchorRuntime.fetchTodayIntention(context) { content ->
                        context.startActivity(Intent(context, IntentCaptureActivity::class.java).apply {
                            putExtra("mode", "manual")
                            putExtra("prefill", content ?: "")
                        })
                    }
                }
            }
        }
        Text(stringResource(R.string.home_rhythm_record), fontSize = 12.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.secondary)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryButton(stringResource(R.string.home_btn_meal),   Modifier.weight(1f)) { confirmEvent = "meal" }
            PrimaryButton(stringResource(R.string.home_btn_leave_room), Modifier.weight(1f)) { confirmEvent = "left_room" }
            PrimaryButton(stringResource(R.string.home_btn_sleep),   Modifier.weight(1f)) { confirmEvent = "sleep_start" }
        }
    }

    val pending = confirmEvent
    if (pending != null) {
        val (titleRes, msgRes) = when (pending) {
            "meal" -> R.string.home_dlg_meal_title to null
            "left_room" -> R.string.home_dlg_leave_room_title to null
            else -> R.string.home_dlg_sleep_title to R.string.home_dlg_sleep_msg
        }
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmEvent = null },
            title = { Text(stringResource(titleRes)) },
            text = { msgRes?.let { Text(stringResource(it)) } },
            confirmButton = { Button(onClick = { model.sendCircadian(pending); confirmEvent = null }) { Text(stringResource(R.string.common_confirm)) } },
            dismissButton = { OutlinedButton(onClick = { confirmEvent = null }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }
}

// 设置面板

private enum class SettingsPage { HOME, TESTS }

private enum class PermissionType { NOTIFICATION, USAGE_STATS, ACCESSIBILITY, OVERLAY }

private data class PermissionStatus(val label: String, val enabled: Boolean, val type: PermissionType)

@Composable
private fun SettingsPanel(state: AnchorUiState, model: AnchorViewModel, modifier: Modifier) {
    var page by remember { mutableStateOf(SettingsPage.HOME) }
    when (page) {
        SettingsPage.HOME -> SettingsHome(state, model, modifier) { page = SettingsPage.TESTS }
        SettingsPage.TESTS -> TestPanel(state, model, modifier) { page = SettingsPage.HOME }
    }
}

@Composable
private fun SettingsHome(state: AnchorUiState, model: AnchorViewModel, modifier: Modifier, openTests: () -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var refreshKey by remember { mutableIntStateOf(0) }
    var showBreachDialog by remember { mutableStateOf(false) }
    var serverUrl by remember { mutableStateOf(AnchorRuntime.currentServerUrl(context)) }

    LaunchedEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) refreshKey++
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        kotlinx.coroutines.awaitCancellation()
        lifecycleOwner.lifecycle.removeObserver(observer)
    }

    val permissions = remember(context, refreshKey) { readPermissionStatuses(context) }
    val allPermissions = permissions.all { it.enabled }
    val dangerColor = Color(0xFFCF222E)
    Column(
        modifier = modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(stringResource(R.string.settings_title), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        Text(stringResource(R.string.settings_subtitle), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary)

        SettingsSectionTitle(stringResource(R.string.settings_section_runtime))
        AnchorCard {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                HealthRow(stringResource(R.string.settings_service), if (state.serviceRunning) stringResource(R.string.common_running) else stringResource(R.string.common_not_started), state.serviceRunning)
                HealthRow(stringResource(R.string.settings_server_conn), if (state.connected) stringResource(R.string.common_connected) else stringResource(R.string.common_disconnected), state.connected)
            }
        }

        SettingsSectionTitle(stringResource(R.string.settings_section_permissions))
        AnchorCard {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                permissions.forEach { perm ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Row(
                            modifier = Modifier.weight(1f),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(
                                if (perm.enabled) Icons.Default.CheckCircle else Icons.Default.Warning,
                                contentDescription = null,
                                modifier = Modifier.size(17.dp),
                                tint = if (perm.enabled) InterventionColor.passive else InterventionColor.curfew
                            )
                            Column {
                                Text(perm.label, style = MaterialTheme.typography.bodyMedium)
                                Text(
                                    if (perm.enabled) stringResource(R.string.common_enabled) else stringResource(R.string.common_disabled),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = if (perm.enabled) InterventionColor.passive else InterventionColor.curfew
                                )
                            }
                        }
                        if (!perm.enabled) {
                            SecondaryButton(
                                stringResource(R.string.settings_btn_goto),
                                modifier = Modifier.width(72.dp)
                            ) {
                                openSpecificPermissionSetting(context, perm.type)
                            }
                        }
                    }
                }
                Text(if (allPermissions) stringResource(R.string.settings_perm_all_ready) else stringResource(R.string.settings_perm_require), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary)
                if (permissions.any { it.type == PermissionType.ACCESSIBILITY && !it.enabled }) {
                    Text(stringResource(R.string.notif_accessibility_lost_text), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                }
                SecondaryButton(stringResource(R.string.settings_btn_open_app_details), Modifier.fillMaxWidth()) {
                    openAppDetailsSettings(context)
                }
            }
        }

        SettingsSectionTitle(stringResource(R.string.settings_section_battery))
        AnchorCard {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.settings_rom_tip), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary)
                SecondaryButton(stringResource(R.string.settings_btn_ignore_battery), Modifier.fillMaxWidth()) {
                    context.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.fromParts("package", context.packageName, null)
                    })
                }
                SecondaryButton(stringResource(R.string.settings_btn_open_app_details), Modifier.fillMaxWidth()) {
                    openAppDetailsSettings(context)
                }
            }
        }

        SettingsSectionTitle(stringResource(R.string.settings_section_sunset))
        AnchorCard {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                HealthRow(stringResource(R.string.settings_current_phase), sunsetPhaseLabel(context, state.sunsetPhase), state.sunsetPhase == "off")
                HealthRow(stringResource(R.string.settings_bedtime), state.bedtimeLabel, true)
                Text(stringResource(R.string.settings_sunset_desc), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary)
            }
        }

        SettingsSectionTitle(stringResource(R.string.settings_section_server))
        PairingSection(context, serverUrl) { serverUrl = it }

        AnchorCard {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(Icons.Default.Build, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.settings_dev_title), style = MaterialTheme.typography.titleSmall)
                    Text(stringResource(R.string.settings_dev_desc), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary)
                }
                SecondaryButton(stringResource(R.string.common_open)) { openTests() }
            }
        }

        SettingsSectionTitle(stringResource(R.string.settings_section_advanced))
        Button(
            onClick = { showBreachDialog = true }, modifier = Modifier.fillMaxWidth().height(40.dp), shape = RoundedCornerShape(6.dp),
            contentPadding = PaddingValues(horizontal = 12.dp), colors = ButtonDefaults.buttonColors(containerColor = dangerColor),
        ) { Text(stringResource(R.string.settings_btn_force_breach), fontSize = 14.sp) }
    }

    if (showBreachDialog) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { showBreachDialog = false },
            title = { Text(stringResource(R.string.settings_dlg_breach_title)) },
            text = { Text(stringResource(R.string.settings_dlg_breach_msg)) },
            confirmButton = { Button(onClick = { model.send(mapOf("type" to "sunset:release", "reason" to "manual")); showBreachDialog = false }) { Text(stringResource(R.string.sunset_release_dialog_confirm)) } },
            dismissButton = { OutlinedButton(onClick = { showBreachDialog = false }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }
}

@Composable
private fun SettingsSectionTitle(title: String) {
    Text(title, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary)
}

/**
 * 配对区块：未配对显示引导表单（服务器地址 + 配对码 + 设备名）；
 * 已配对显示绿色状态条 + 「重新配对」按钮（展开表单覆盖）。
 */
@Composable
private fun PairingSection(context: Context, initialServerUrl: String, onServerUrlChange: (String) -> Unit) {
    val prefs = context.getSharedPreferences("anchor", Context.MODE_PRIVATE)
    var paired by remember { mutableStateOf(PairingStore.isPaired(prefs)) }
    var repairing by remember { mutableStateOf(false) }
    // 表单状态：rememberSaveable 防旋转/重组成丢失
    var serverUrl by rememberSaveable { mutableStateOf(initialServerUrl) }
    var code by rememberSaveable { mutableStateOf("") }
    var deviceName by rememberSaveable { mutableStateOf(PairingStore.deviceName(prefs) ?: PairingStore.defaultDeviceName()) }
    var pairing by remember { mutableStateOf(false) }
    var feedback by remember { mutableStateOf<String?>(null) }
    var success by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    if (!paired || repairing) {
        AnchorCard {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.pair_welcome_title), style = MaterialTheme.typography.titleSmall)
                Text(stringResource(R.string.pair_welcome_desc), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary)
                OutlinedTextField(
                    value = serverUrl, onValueChange = { serverUrl = it }, label = { Text(stringResource(R.string.common_server_url)) }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(6.dp),
                    colors = TextFieldDefaults.colors(
                        focusedIndicatorColor = MaterialTheme.colorScheme.primary,
                        unfocusedIndicatorColor = MaterialTheme.colorScheme.outline,
                        focusedContainerColor = MaterialTheme.colorScheme.surface,
                        unfocusedContainerColor = MaterialTheme.colorScheme.surface,
                    ),
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SecondaryButton(stringResource(R.string.common_usb_forward), Modifier.weight(1f)) { serverUrl = "http://localhost:4000" }
                    if (repairing) {
                        SecondaryButton(stringResource(R.string.pair_repair_cancel), Modifier.weight(1f)) { repairing = false }
                    }
                }
                Text(stringResource(R.string.settings_usb_tip), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary)
                OutlinedTextField(
                    value = code, onValueChange = { code = it }, label = { Text(stringResource(R.string.pair_code_label)) },
                    placeholder = { Text(stringResource(R.string.pair_code_hint)) }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(6.dp),
                    colors = TextFieldDefaults.colors(
                        focusedIndicatorColor = MaterialTheme.colorScheme.primary,
                        unfocusedIndicatorColor = MaterialTheme.colorScheme.outline,
                        focusedContainerColor = MaterialTheme.colorScheme.surface,
                        unfocusedContainerColor = MaterialTheme.colorScheme.surface,
                    ),
                )
                OutlinedTextField(
                    value = deviceName, onValueChange = { deviceName = it }, label = { Text(stringResource(R.string.pair_device_name_label)) }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(6.dp),
                    colors = TextFieldDefaults.colors(
                        focusedIndicatorColor = MaterialTheme.colorScheme.primary,
                        unfocusedIndicatorColor = MaterialTheme.colorScheme.outline,
                        focusedContainerColor = MaterialTheme.colorScheme.surface,
                        unfocusedContainerColor = MaterialTheme.colorScheme.surface,
                    ),
                )
                PrimaryButton(if (pairing) stringResource(R.string.pair_pairing) else stringResource(R.string.pair_btn), Modifier.fillMaxWidth()) {
                    if (pairing) return@PrimaryButton
                    pairing = true
                    feedback = null
                    success = false
                    scope.launch {
                        val result = PairingClient.pair(serverUrl, code, deviceName, BuildConfig.VERSION_NAME)
                        pairing = false
                        when (result) {
                            is PairResult.Success -> {
                                // data_key 由服务器下发覆盖；落库后重启 WS 全量开始上报
                                AnchorRuntime.applyPairResult(context, result, deviceName, serverUrl)
                                onServerUrlChange(serverUrl.trim().trimEnd('/'))
                                paired = true
                                repairing = false
                                code = ""
                                success = true
                                feedback = context.getString(R.string.pair_success_format, result.serverVersion)
                            }
                            is PairResult.Failure -> {
                                success = false
                                feedback = context.getString(R.string.pair_fail_format, result.error)
                            }
                        }
                    }
                }
                feedback?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = if (success) InterventionColor.passive else MaterialTheme.colorScheme.error)
                }
            }
        }
    } else {
        // 已配对态：绿色状态条 + 重新配对入口
        AnchorCard {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Default.CheckCircle, contentDescription = null, modifier = Modifier.size(17.dp), tint = InterventionColor.passive)
                Text(
                    stringResource(R.string.pair_status_format, PairingStore.deviceName(prefs) ?: ""),
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.weight(1f),
                )
                SecondaryButton(stringResource(R.string.pair_repair)) {
                    serverUrl = AnchorRuntime.currentServerUrl(context)
                    repairing = true
                }
            }
        }
    }
}

@Composable
private fun HealthRow(label: String, value: String, enabled: Boolean) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(if (enabled) Icons.Default.CheckCircle else Icons.Default.Warning, contentDescription = null, modifier = Modifier.size(17.dp), tint = if (enabled) InterventionColor.passive else InterventionColor.curfew)
            Text(label, style = MaterialTheme.typography.bodyMedium)
        }
        Text(value, fontSize = 13.sp, color = if (enabled) InterventionColor.passive else InterventionColor.curfew)
    }
}

@Composable
private fun TestPanel(state: AnchorUiState, model: AnchorViewModel, modifier: Modifier, goBack: () -> Unit) {
    val context = LocalContext.current
    var result by remember { mutableStateOf<String?>(null) }
    val permissions = readPermissionStatuses(context)
    val announce: (String) -> Unit = { result = it }
    fun requireOverlay(action: () -> Unit) {
        if (Settings.canDrawOverlays(context)) action() else announce(context.getString(R.string.dev_overlay_perm_required))
    }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            SecondaryButton(stringResource(R.string.common_back)) { goBack() }
            Spacer(Modifier.width(12.dp))
            Column { Text(stringResource(R.string.dev_title), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold); Text(stringResource(R.string.dev_desc), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary) }
        }
        AnchorCard {
            Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                Text(stringResource(R.string.dev_sys_check), style = MaterialTheme.typography.titleSmall)
                permissions.forEach { HealthRow(it.label, if (it.enabled) stringResource(R.string.common_enabled) else stringResource(R.string.common_disabled), it.enabled) }
                HealthRow(stringResource(R.string.settings_service), if (state.serviceRunning) stringResource(R.string.common_running) else stringResource(R.string.common_not_started), state.serviceRunning)
                HealthRow(stringResource(R.string.dev_websocket), if (state.connected) stringResource(R.string.common_connected) else stringResource(R.string.common_disconnected), state.connected)
            }
        }
        TestSection(stringResource(R.string.dev_section_notif)) {
            TestButton(stringResource(R.string.dev_btn_notif_generic)) { AnchorNotifications.showSoftIntervention(context, context.getString(R.string.dev_test_generic_body)) ; announce(context.getString(R.string.dev_done_notif_generic)) }
            TestButton(stringResource(R.string.dev_btn_notif_ai)) { AnchorNotifications.showAi(context, context.getString(R.string.dev_test_ai_body)) ; announce(context.getString(R.string.dev_done_notif_ai)) }
            TestButton(stringResource(R.string.dev_btn_notif_intent)) { AnchorNotifications.showIntentCapture(context, context.getString(R.string.dev_test_intent_prompt)) ; announce(context.getString(R.string.dev_done_notif_intent)) }
            TestButton(stringResource(R.string.dev_btn_notif_soft)) { AnchorNotifications.showSoftIntervention(context, context.getString(R.string.dev_test_soft_body)) ; announce(context.getString(R.string.dev_done_notif_soft)) }
            TestButton(stringResource(R.string.dev_btn_notif_strong)) { requireOverlay { AnchorNotifications.showStrongIntervention(context, context.getString(R.string.dev_test_strong_body), "com.bilibili"); announce(context.getString(R.string.dev_done_notif_strong)) } }
        }
        TestSection(stringResource(R.string.dev_section_sunset)) {
            TestButton(stringResource(R.string.dev_btn_sunset_t60)) { AnchorRuntime.triggerSunsetPhase(context, "T60"); announce(context.getString(R.string.dev_done_sunset_t60)) }
            TestButton(stringResource(R.string.dev_btn_sunset_t30)) { AnchorRuntime.triggerSunsetPhase(context, "T30"); announce(context.getString(R.string.dev_done_sunset_t30)) }
            TestButton(stringResource(R.string.dev_btn_sunset_t15)) { AnchorRuntime.triggerSunsetPhase(context, "T15"); announce(context.getString(R.string.dev_done_sunset_t15)) }
            TestButton(stringResource(R.string.dev_btn_sunset_t0)) { requireOverlay { AnchorRuntime.triggerSunsetPhase(context, "T0"); announce(context.getString(R.string.dev_done_sunset_t0)) } }
            TestButton(stringResource(R.string.dev_btn_sunset_off)) { AnchorRuntime.triggerSunsetPhase(context, "off"); announce(context.getString(R.string.dev_done_sunset_off)) }
        }
        TestSection(stringResource(R.string.dev_section_interaction)) {
            TestButton(stringResource(R.string.dev_btn_wakeup)) { context.startActivity(Intent(context, WakeupActivity::class.java)); announce(context.getString(R.string.dev_done_wakeup)) }
            TestButton(stringResource(R.string.dev_btn_state_update)) { model.send(mapOf("type" to "state:update", "state" to "working")); announce(context.getString(R.string.dev_done_state_update)) }
            TestButton(stringResource(R.string.dev_btn_refresh_notif)) { AnchorService.updateForegroundNotification(context); announce(context.getString(R.string.dev_done_refresh_notif)) }
        }
        result?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary) }
    }
}

@Composable
private fun TestSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    AnchorCard { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { Text(title, style = MaterialTheme.typography.titleSmall); content() } }
}

@Composable
private fun TestButton(label: String, onClick: () -> Unit) {
    SecondaryButton(label, Modifier.fillMaxWidth(), onClick)
}

private fun sunsetPhaseLabel(c: Context, phase: String): String = when (phase) {
    "T60" -> c.getString(R.string.sunset_t60)
    "T30" -> c.getString(R.string.sunset_t30)
    "T15" -> c.getString(R.string.sunset_t15)
    "T0" -> c.getString(R.string.sunset_t0)
    else -> c.getString(R.string.sunset_off)
}

private fun readPermissionStatuses(context: Context): List<PermissionStatus> {
    val notification = if (android.os.Build.VERSION.SDK_INT >= 33) context.checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED else true
    val usage = (context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager).unsafeCheckOpNoThrow("android:get_usage_stats", Process.myUid(), context.packageName) == AppOpsManager.MODE_ALLOWED
    val overlay = Settings.canDrawOverlays(context)
    val accessibility = android.provider.Settings.Secure.getString(context.contentResolver, "enabled_accessibility_services")?.split(':')?.any { it.equals(ComponentName(context, AnchorAccessibilityService::class.java).flattenToString(), true) } == true
    return listOf(
        PermissionStatus(context.getString(R.string.perm_notification), notification, PermissionType.NOTIFICATION),
        PermissionStatus(context.getString(R.string.perm_usage_stats), usage, PermissionType.USAGE_STATS),
        PermissionStatus(context.getString(R.string.perm_accessibility), accessibility, PermissionType.ACCESSIBILITY),
        PermissionStatus(context.getString(R.string.perm_overlay), overlay, PermissionType.OVERLAY)
    )
}

private fun openAppDetailsSettings(context: Context) {
    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
        data = Uri.fromParts("package", context.packageName, null)
    }
    context.startActivity(intent)
}

private fun openSpecificPermissionSetting(context: Context, type: PermissionType) {
    val intent = when (type) {
        PermissionType.NOTIFICATION -> {
            if (Build.VERSION.SDK_INT >= 26) {
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                    putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                }
            } else {
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.fromParts("package", context.packageName, null)
                }
            }
        }
        PermissionType.USAGE_STATS -> Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
        PermissionType.ACCESSIBILITY -> Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
        PermissionType.OVERLAY -> Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION).apply {
            data = Uri.fromParts("package", context.packageName, null)
        }
    }
    context.startActivity(intent)
}
