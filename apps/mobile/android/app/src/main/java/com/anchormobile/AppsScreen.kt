package com.anchormobile

import android.content.Context
import android.graphics.drawable.Drawable
import androidx.compose.foundation.Image
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class AppClassificationItem(
    val packageName: String,
    val appName: String,
    val highStimulus: Boolean,
    val isWork: Boolean,
    val icon: Drawable? = null,
)

// 三态分类：高刺激 / 中性 / 工作（与服务器 is_work 互斥模型对齐）
// SharedPreferences 键约定（每态恰好一个 true 键）：
//   classified_high_<pkg> / classified_low_<pkg> / classified_work_<pkg>
// 另有 classified_name_<pkg> 缓存服务器下发的应用名，供本机未安装应用回退显示

@Composable
fun AppsScreen(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var apps by remember { mutableStateOf<List<AppClassificationItem>>(emptyList()) }
    var filter by remember { mutableStateOf<String?>(null) }
    var syncing by remember { mutableStateOf(false) }
    var initialLoading by remember { mutableStateOf(true) }
    var syncMessage by remember { mutableStateOf<String?>(null) }

    // 后台重载本地缓存（PackageManager 查询不应跑在主线程）
    suspend fun reloadApps() {
        apps = withContext(Dispatchers.IO) { loadClassifiedApps(context) }
    }

    // 首次进入：加载本地缓存后立即自动同步服务器，失败保留本地数据
    LaunchedEffect(Unit) {
        reloadApps()
        syncClassificationsFromServer(context) { ok ->
            initialLoading = false
            if (!ok) syncMessage = "同步失败，显示本地数据"
        }
    }

    // WS 推送或手动同步后版本号变化，自动重载列表
    val classVersion by AnchorRuntime.classificationVersion.collectAsState()
    LaunchedEffect(classVersion) {
        if (classVersion > 0) reloadApps()
    }

    LaunchedEffect(syncMessage) {
        if (syncMessage != null) {
            kotlinx.coroutines.delay(2500)
            syncMessage = null
        }
    }

    val filtered = when (filter) {
        "high" -> apps.filter { it.highStimulus }
        "neutral" -> apps.filter { !it.highStimulus && !it.isWork }
        "work" -> apps.filter { it.isWork }
        else -> apps
    }

    Column(modifier.fillMaxSize().padding(20.dp)) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("高刺激 App 管理", style = MaterialTheme.typography.titleLarge)
            IconButton(
                onClick = {
                    syncing = true
                    syncClassificationsFromServer(context) { ok ->
                        syncing = false
                        syncMessage = if (ok) "同步完成" else "同步失败"
                    }
                },
                enabled = !syncing
            ) {
                if (syncing) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                } else {
                    Icon(Icons.Default.Sync, "从服务器同步")
                }
            }
        }
        syncMessage?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary)
        }
        Spacer(Modifier.height(12.dp))

        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            FilterChip(
                selected = filter == null,
                onClick = { filter = null },
                label = { Text("全部 (${apps.size})") }
            )
            FilterChip(
                selected = filter == "high",
                onClick = { filter = "high" },
                label = { Text("高刺激 (${apps.count { it.highStimulus }})") }
            )
            FilterChip(
                selected = filter == "neutral",
                onClick = { filter = "neutral" },
                label = { Text("中性 (${apps.count { !it.highStimulus && !it.isWork }})") }
            )
            FilterChip(
                selected = filter == "work",
                onClick = { filter = "work" },
                label = { Text("工作 (${apps.count { it.isWork }})") }
            )
        }

        Spacer(Modifier.height(12.dp))

        when {
            initialLoading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            filtered.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("暂无应用", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.secondary)
            }
            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(filtered) { app ->
                    AppClassificationCard(
                        app = app,
                        onToggle = {
                            toggleAppClassification(context, app.packageName, app.highStimulus, app.isWork)
                            scope.launch { reloadApps() }
                        },
                        onDelete = {
                            deleteAppClassificationLocal(context, app.packageName)
                            scope.launch { reloadApps() }
                        }
                    )
                }
            }
        }
    }
}

@Composable
private fun AppClassificationCard(
    app: AppClassificationItem,
    onToggle: () -> Unit,
    onDelete: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
    ) {
        Row(
            Modifier.fillMaxWidth().padding(12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                if (app.icon != null) {
                    val bitmap = remember(app.packageName) {
                        val bmp = android.graphics.Bitmap.createBitmap(96, 96, android.graphics.Bitmap.Config.ARGB_8888)
                        val canvas = android.graphics.Canvas(bmp)
                        app.icon.setBounds(0, 0, 96, 96)
                        app.icon.draw(canvas)
                        bmp
                    }
                    Image(
                        bitmap = bitmap.asImageBitmap(),
                        contentDescription = app.appName,
                        modifier = Modifier.size(40.dp).padding(end = 12.dp)
                    )
                } else {
                    Icon(
                        Icons.Default.Android,
                        contentDescription = null,
                        modifier = Modifier.size(40.dp).padding(end = 12.dp),
                        tint = MaterialTheme.colorScheme.secondary
                    )
                }
                Column {
                    Text(app.appName, style = MaterialTheme.typography.bodyLarge)
                    Text(app.packageName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary)
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = when {
                        app.isWork -> Color(0xFF0969DA)
                        app.highStimulus -> Color(0xFFCF222E)
                        else -> Color(0xFF6E7781)
                    }
                ) {
                    Text(
                        when {
                            app.isWork -> "工作"
                            app.highStimulus -> "高刺激"
                            else -> "中性"
                        },
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        style = MaterialTheme.typography.labelSmall,
                        color = Color.White
                    )
                }
                IconButton(onClick = onToggle) { Icon(Icons.Default.SwapHoriz, "切换") }
                IconButton(onClick = onDelete) { Icon(Icons.Default.Delete, "删除") }
            }
        }
    }
}

private fun loadClassifiedApps(context: Context): List<AppClassificationItem> {
    val prefs = context.getSharedPreferences("anchor", Context.MODE_PRIVATE)
    val apps = mutableListOf<AppClassificationItem>()

    prefs.all.keys.forEach { key ->
        if (key.startsWith("classified_high_")) {
            val packageName = key.removePrefix("classified_high_")
            val isHigh = prefs.getBoolean(key, false)
            val isWork = prefs.getBoolean("classified_work_$packageName", false)
            val appName = getAppName(context, packageName)
            val icon = getAppIcon(context, packageName)
            apps.add(AppClassificationItem(packageName, appName, isHigh && !isWork, isWork, icon))
        }
    }

    return apps.distinctBy { it.packageName }.sortedBy { it.appName }
}

private fun getAppIcon(context: Context, packageName: String): Drawable? {
    return runCatching {
        context.packageManager.getApplicationIcon(context.packageManager.getApplicationInfo(packageName, 0))
    }.getOrNull()
}

/** 应用名：优先本机 PackageManager，未安装时回退服务器 sync 缓存的 app_name */
private fun getAppName(context: Context, packageName: String): String {
    return runCatching {
        val pm = context.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
    }.getOrNull() ?: context.getSharedPreferences("anchor", Context.MODE_PRIVATE)
        .getString("classified_name_$packageName", null)
        ?: packageName
}

/** 全量拉取服务器分类列表，替换本地缓存（跳过 pending 行） */
private fun syncClassificationsFromServer(context: Context, onDone: (Boolean) -> Unit) {
    Thread {
        val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
        try {
            val serverUrl = AnchorRuntime.currentServerUrl(context)
            val client = okhttp3.OkHttpClient.Builder()
                .connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
                .readTimeout(10, java.util.concurrent.TimeUnit.SECONDS)
                .build()
            val request = okhttp3.Request.Builder()
                .url("$serverUrl/api/apps/classifications")
                .get()
                .build()
            val response = client.newCall(request).execute()
            if (!response.isSuccessful) {
                mainHandler.post { onDone(false) }
                return@Thread
            }
            val json = com.google.gson.Gson().fromJson(response.body?.string(), com.google.gson.JsonObject::class.java)
            val list = json.getAsJsonArray("classifications") ?: run {
                mainHandler.post { onDone(false) }
                return@Thread
            }

            val prefs = context.getSharedPreferences("anchor", Context.MODE_PRIVATE)
            val editor = prefs.edit()
            // 清空旧缓存（覆盖 high/low/work/name 四个前缀，旧版本 work 误存为 low 的脏数据一并清除）
            prefs.all.keys
                .filter {
                    it.startsWith("classified_high_") || it.startsWith("classified_low_") ||
                        it.startsWith("classified_work_") || it.startsWith("classified_name_")
                }
                .forEach { editor.remove(it) }
            // 写入服务器数据，pending 行跳过（结果未定，等下次触发重新分类）
            list.forEach { el ->
                val obj = el.asJsonObject
                if (obj.get("classification_source")?.asString == "pending") return@forEach
                val pkg = obj.get("package_name")?.asString ?: return@forEach
                val high = obj.get("high_stimulus")?.asBoolean ?: return@forEach
                val isWork = obj.get("is_work")?.asBoolean ?: false
                val appName = obj.get("app_name")?.asString
                // 三态互斥：is_work 为真时强制 high=false（防御服务器历史脏数据）
                editor.putBoolean("classified_high_$pkg", high && !isWork)
                editor.putBoolean("classified_low_$pkg", !high && !isWork)
                editor.putBoolean("classified_work_$pkg", isWork)
                if (appName != null) editor.putString("classified_name_$pkg", appName)
            }
            editor.apply()
            AnchorRuntime.notifyClassificationsChanged()
            mainHandler.post { onDone(true) }
        } catch (e: Exception) {
            e.printStackTrace()
            mainHandler.post { onDone(false) }
        }
    }.start()
}

/** 循环切换三态：高刺激→中性→工作→高刺激；本地乐观更新 + WS 上报服务器 */
private fun toggleAppClassification(context: Context, packageName: String, currentHigh: Boolean, currentIsWork: Boolean) {
    val (newHigh, newWork) = when {
        currentIsWork -> true to false   // 工作 → 高刺激
        currentHigh -> false to false    // 高刺激 → 中性
        else -> false to true            // 中性 → 工作
    }
    val prefs = context.getSharedPreferences("anchor", Context.MODE_PRIVATE)
    prefs.edit().apply {
        putBoolean("classified_high_$packageName", newHigh)
        putBoolean("classified_low_$packageName", !newHigh && !newWork)
        putBoolean("classified_work_$packageName", newWork)
        apply()
    }

    AnchorRuntime.send(mapOf(
        "type" to "app:update_classification",
        "package_name" to packageName,
        "high_stimulus" to newHigh,
        "is_work" to newWork
    ))
}

private fun deleteAppClassificationLocal(context: Context, packageName: String) {
    val prefs = context.getSharedPreferences("anchor", Context.MODE_PRIVATE)
    prefs.edit().apply {
        remove("classified_high_$packageName")
        remove("classified_low_$packageName")
        remove("classified_work_$packageName")
        remove("classified_name_$packageName")
        apply()
    }

    AnchorRuntime.send(mapOf(
        "type" to "app:delete_classification",
        "package_name" to packageName
    ))
}
