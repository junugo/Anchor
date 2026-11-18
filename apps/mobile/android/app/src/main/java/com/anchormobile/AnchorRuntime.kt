package com.anchormobile

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import com.google.gson.Gson
import com.google.gson.JsonObject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import okhttp3.OkHttpClient
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.Response
import java.util.concurrent.TimeUnit

object AnchorRuntime {
    private val gson = Gson()
    private val client = OkHttpClient.Builder().pingInterval(30, TimeUnit.SECONDS).build()
    private val mutableState = MutableStateFlow(AnchorUiState())
    val state: StateFlow<AnchorUiState> = mutableState
    private val mutableClassificationVersion = MutableStateFlow(0)
    val classificationVersion: StateFlow<Int> = mutableClassificationVersion
    private var webSocket: WebSocket? = null
    const val DEFAULT_SERVER_URL = "http://localhost:4000"
    private var serverUrl = DEFAULT_SERVER_URL
    private val retryHandler = Handler(Looper.getMainLooper())
    private var retryCount = 0
    private var explicitStop = false
    private var lastContext: Context? = null
    private val reconnectTask = Runnable { lastContext?.let { connect(it) } }
    private var sunsetExpiryAt = 0L
    private var sunsetBedtimeAt = 0L
    private val FLUSH_CHUNK_SIZE = 100
    /** 本端已上报开始输入（接管弹窗）：收到 typing 广播时识别自身广播，不清空状态 */
    @Volatile private var contextSwitchInputSent = false
    @Volatile private var intentInputSent = false

    /** 宵禁过期守护：每分钟检查一次，expires_at 已过则本地解除（断线兜底） */
    private val sunsetExpiryGuard = object : Runnable {
        override fun run() {
            val phase = state.value.sunsetPhase
            if (phase != "off" && sunsetExpiryAt > 0 && System.currentTimeMillis() / 1000 > sunsetExpiryAt) {
                lastContext?.let { applySunsetPhase(it, "off", 0L, 0L) }
            }
            retryHandler.postDelayed(this, 60_000L)
        }
    }

    fun start(context: Context) {
        lastContext = context.applicationContext
        explicitStop = false
        AnchorNotifications.init(context)
        restoreSunsetStage(context)
        mutableState.update { it.copy(serviceRunning = true) }
        retryHandler.removeCallbacks(sunsetExpiryGuard)
        retryHandler.postDelayed(sunsetExpiryGuard, 60_000L)
        connect(context)
    }

    fun stop() {
        explicitStop = true
        retryHandler.removeCallbacksAndMessages(null)
        webSocket?.close(1000, "service stopped")
        webSocket = null
        mutableState.update { it.copy(connected = false, serviceRunning = false) }
    }

    fun setTab(tab: Int) { mutableState.update { it.copy(tab = tab) } }

    /** 手动同步等外部更新本地分类缓存后调用，驱动 UI 刷新 */
    fun notifyClassificationsChanged() { mutableClassificationVersion.update { it + 1 } }

    fun currentServerUrl(context: Context): String =
        context.getSharedPreferences("anchor", Context.MODE_PRIVATE).getString("server_url", serverUrl) ?: serverUrl

    /** 上行加密密钥：配对成功后由服务器下发覆盖；未配置返回 null，上报路径须跳过 */
    private fun currentDataKey(): String? =
        lastContext?.getSharedPreferences("anchor", Context.MODE_PRIVATE)?.getString("data_key", null)

    fun isPaired(): Boolean = lastContext?.let { PairingStore.isPaired(it) } ?: false

    /** 配对成功落库 + 重启 WS（清退避/失效标记） */
    fun applyPairResult(context: Context, result: PairResult.Success, deviceName: String, serverUrl: String) {
        val prefs = context.getSharedPreferences("anchor", Context.MODE_PRIVATE)
        PairingStore.applyPairSuccess(prefs, result, deviceName, serverUrl)
        retryCount = 0
        explicitStop = false
        connect(context.applicationContext)
    }

    fun connect(context: Context) {
        val prefs = context.getSharedPreferences("anchor", Context.MODE_PRIVATE)
        serverUrl = prefs.getString("server_url", serverUrl)?.trimEnd('/') ?: serverUrl
        // 未配对不上报：本地状态机照常，WS 不上线（无有效 token 服务器会 4401 关闭）
        if (!PairingStore.isPaired(prefs)) {
            android.util.Log.i("Anchor", "未配对，跳过服务器连接；完成配对后自动上线")
            // 清现场与正常 connect 开头对称：防旧重连任务/旧 socket 残留
            retryHandler.removeCallbacks(reconnectTask)
            webSocket?.cancel()
            webSocket = null
            mutableState.update { it.copy(connected = false) }
            return
        }
        val token = PairingStore.token(prefs)
        android.util.Log.i("Anchor", "connect to $serverUrl, data_key_fp=${currentDataKey()?.let { Crypto.keyFingerprint(it) }}")
        retryHandler.removeCallbacks(reconnectTask)
        webSocket?.cancel()
        webSocket = client.newWebSocket(
            Request.Builder().url(serverUrl.replaceFirst("http", "ws") + "/ws").build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    // 连接建立后第一条消息必须完成认证，否则服务器超时 4401 关闭
                    token?.let { webSocket.send(gson.toJson(mapOf("type" to "auth", "token" to it))) }
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (code == 4401) { authFailed(); return }
                    disconnected()
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { disconnected() }
                override fun onMessage(webSocket: WebSocket, text: String) { handleMessage(text) }
            }
        )
    }

    /** 配对失效：置运行标志 + 系统通知 + 停重连（直到重新配对） */
    private fun authFailed() {
        mutableState.update { it.copy(connected = false) }
        lastContext?.let { ctx ->
            PairingStore.markPairInvalid(ctx.getSharedPreferences("anchor", Context.MODE_PRIVATE))
            AnchorNotifications.showPairInvalid(ctx)
        }
    }

    private fun disconnected() {
        mutableState.update { it.copy(connected = false) }
        if (explicitStop) return
        // 配对失效后不重连：authFailed 已置 pair_invalid，重连只会再被 4401 打回
        if (lastContext?.let { !PairingStore.isPaired(it) } == true) return
        retryCount += 1
        // 对齐 desktop-rs：前 10 次 5s 快重试，之后进入 60s 心跳模式，永不放弃
        scheduleReconnect(if (retryCount <= 10) 5_000L else 60_000L)
    }

    private fun scheduleReconnect(delayMs: Long) {
        retryHandler.removeCallbacks(reconnectTask)
        retryHandler.postDelayed(reconnectTask, delayMs)
    }

    fun send(message: Map<String, Any?>) {
        // 未配对不上报：本地采集照常，网络路径整体跳过
        if (!isPaired()) {
            android.util.Log.d("Anchor", "未配对，跳过上报")
            return
        }
        // 配置错误状态：禁止发送
        if (mutableState.value.configError != null) {
            android.util.Log.i("Anchor", "配置错误，跳过发送")
            return
        }
        // ingest 事件统一补打事件发生时间（Unix 秒）
        val enriched = if (message["type"] == "ingest" && message["logged_at"] == null) {
            message + ("logged_at" to System.currentTimeMillis() / 1000)
        } else {
            message
        }
        // 仅 ingest 行为数据加密上行；交互/控制消息明文
        // 加密/入队异常必须吞掉：send 可能由无障碍服务主线程调用，异常会拖垮服务
        val payload = if (enriched["type"] == "ingest") {
            runCatching { Crypto.encryptEnvelope(gson.toJson(enriched), currentDataKey()) }.getOrNull() ?: return
        } else {
            gson.toJson(enriched)
        }
        val sent = webSocket?.send(payload) == true
        if (!sent && enriched["type"] == "ingest") {
            // WS 未连接：入队（存明文，drain 时转 batch 结构并加密 body），重连后批量补发；非 ingest 消息过期无效直接丢弃
            lastContext?.let { ctx ->
                runCatching { OfflineQueue.get(ctx).enqueue(gson.toJson(enriched)) }
                // 兜底唤醒：重试链断裂时补排一次 60s 心跳重连（避免被 15s 上报打成高频）
                if (!explicitStop && !retryHandler.hasCallbacks(reconnectTask)) {
                    if (retryCount < 10) retryCount = 10
                    scheduleReconnect(60_000L)
                }
            }
        }
    }

    /** 重连后批量补发：分块 POST /api/ingest/batch，成功一块删一块，失败停止 */
    private fun flushOfflineQueue() {
        val ctx = lastContext ?: return
        if (!isPaired()) return
        Thread {
            val queue = OfflineQueue.get(ctx)
            queue.dropExpired()
            while (true) {
                val chunk = queue.pendingChunk(FLUSH_CHUNK_SIZE)
                if (chunk.isEmpty()) break
                val logs = chunk.mapNotNull { (_, body) -> toBatchEntry(body) }
                if (logs.isEmpty()) {
                    // 非 ingest 遗留数据（旧版本可能入队过其他消息）直接清除
                    queue.remove(chunk.map { it.first })
                    continue
                }
                val logsArray = com.google.gson.JsonArray()
                logs.forEach { logsArray.add(it) }
                val requestJson = JsonObject().apply { add("logs", logsArray) }
                val ok = try {
                    val body = Crypto.encryptEnvelope(gson.toJson(requestJson), currentDataKey())
                        .toRequestBody("application/json; charset=utf-8".toMediaType())
                    val req = Request.Builder()
                        .url("$serverUrl/api/ingest/batch")
                        .post(body)
                        .build()
                    client.newCall(req).execute().use { it.isSuccessful }
                } catch (e: Exception) {
                    false
                }
                if (ok) {
                    queue.remove(chunk.map { it.first })
                } else {
                    queue.bumpRetries(chunk.map { it.first })
                    break
                }
            }
        }.start()
    }

    /** WS ingest 消息 → batch logs 条目；非 ingest 返回 null */
    private fun toBatchEntry(body: String): JsonObject? {
        return try {
            val obj = gson.fromJson(body, JsonObject::class.java)
            if (obj.get("type")?.asString != "ingest") return null
            JsonObject().apply {
                add("source", obj.get("source"))
                add("event_type", obj.get("event_type"))
                add("payload", obj.get("payload") ?: JsonObject())
                add("logged_at", obj.get("logged_at"))
            }
        } catch (e: Exception) {
            null
        }
    }

    /** 本地测试用宵禁切换；真实状态仍由服务器 sunset:phase 消息驱动。 */
    fun triggerSunsetPhase(context: Context, phase: String) {
        applySunsetPhase(context, phase, System.currentTimeMillis() / 1000 + if (phase == "T0") 8 * 60 * 60 else 60 * 60, 0L)
    }

    /** 统一应用宵禁阶段：内存状态 + 持久化 + 通知 + 遮罩 */
    private fun applySunsetPhase(context: Context, phase: String, expiresAt: Long, bedtimeAt: Long) {
        mutableState.update { it.copy(sunsetPhase = phase) }
        persistSunsetStage(context, phase, expiresAt, bedtimeAt)
        AnchorNotifications.showPhase(context, phase, bedtimeAt.takeIf { it > 0 })
        SunsetOverlayService.apply(context, phase)
    }

    private fun persistSunsetStage(context: Context, phase: String, expiresAt: Long, bedtimeAt: Long = sunsetBedtimeAt) {
        sunsetExpiryAt = expiresAt
        sunsetBedtimeAt = bedtimeAt
        context.getSharedPreferences("anchor", Context.MODE_PRIVATE).edit()
            .putString("sunset_stage", phase).putLong("sunset_expires_at", expiresAt).putLong("sunset_bedtime_at", bedtimeAt).apply()
    }

    private fun restoreSunsetStage(context: Context) {
        val prefs = context.getSharedPreferences("anchor", Context.MODE_PRIVATE)
        val phase = prefs.getString("sunset_stage", "off") ?: "off"
        val expiresAt = prefs.getLong("sunset_expires_at", 0L)
        val bedtimeAt = prefs.getLong("sunset_bedtime_at", 0L)
        if (phase != "off" && expiresAt > System.currentTimeMillis() / 1000) {
            sunsetExpiryAt = expiresAt
            sunsetBedtimeAt = bedtimeAt
            mutableState.update { it.copy(sunsetPhase = phase) }
            AnchorNotifications.showPhase(context, phase, bedtimeAt.takeIf { it > 0 })
            SunsetOverlayService.apply(context, phase)
        } else {
            persistSunsetStage(context, "off", 0L, 0L)
        }
    }

    private fun launchCurfew(context: Context) {
        context.startActivity(Intent(context, CurfewActivity::class.java).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT) })
    }

    fun respondToIntervention(choice: String) {
        val current = state.value
        val level   = current.interventionLevel ?: "strong"
        val action  = current.interventionAction
        val id      = current.interventionId
        if (action != null && id != null) {
            send(mapOf(
                "type"            to "intervention_result",
                "source"          to "android",
                "intervention_id" to id,
                "action"          to action,
                "result"          to if (choice == "accepted") "executed" else "dismissed",
                "dismissed_by_user" to (choice != "accepted"),
            ))
        } else {
            send(mapOf(
                "type"         to "intervention:response",
                "level"        to if (level == "soft") "soft" else "strong",
                "choice"       to choice,
                "detected_app" to current.detectedApp,
            ))
        }
        mutableState.update { it.copy(interventionMessage = null, interventionId = null, interventionLevel = null, interventionAction = null, detectedApp = null) }
    }

    fun submitIntent(content: String, source: String = "system", date: String? = null, promptId: String? = null) {
        // source="skip" 时不向服务器提交
        if (source != "skip") {
            val msg = mutableMapOf<String, Any?>("type" to "intent:submit", "content" to content, "source" to source, "date" to date)
            // 空串 promptId（本地重开）不上报，服务器按无匹配处理
            if (!promptId.isNullOrEmpty()) msg["prompt_id"] = promptId
            send(msg)
        }
        // 本地立即清除（服务器随后广播 dismiss answered 兜底）
        mutableState.update { it.copy(intentCapture = null) }
    }

    /** 意图弹窗响应：skip / auto_skip，先到先赢，服务器广播 dismiss 关闭其余端 */
    fun captureResponse(promptId: String, action: String) {
        if (promptId.isEmpty()) return // 本地重开：无活跃捕获，不上报
        send(mapOf("type" to "intent:capture-response", "prompt_id" to promptId, "action" to action))
        // skip/auto_skip 仅关弹窗，重开入口（通知）保留：本地把 promptId 置空转入重开模式
        mutableState.update { s -> s.intentCapture?.let { s.copy(intentCapture = it.copy(promptId = "")) } ?: s }
    }

    fun confirmIntent(date: String) {
        send(mapOf("type" to "intent:confirm", "date" to date))
        mutableState.update { it.copy(intentConfirm = null) }
    }

    /** 状态切换弹窗响应：submit/skip/auto_skip；服务器先到先赢并全端广播关闭 */
    fun respondContextSwitch(context: Context, action: String, text: String?) {
        val promptId = state.value.contextSwitchPromptId ?: return
        send(mapOf(
            "type"      to "context_switch:response",
            "prompt_id" to promptId,
            "action"    to action,
            "text"      to text,
            "source"    to "android",
        ))
        mutableState.update { it.copy(contextSwitchPromptId = null, contextSwitchPlaceholder = null, contextSwitchDeadline = 0) }
        AnchorNotifications.cancelContextSwitch(context)
    }

    /** 状态切换弹窗开始输入（接管）：首次输入时上报一次，服务器广播 typing 关闭其他端 */
    fun notifyContextSwitchTyping() {
        val promptId = state.value.contextSwitchPromptId ?: return
        if (contextSwitchInputSent) return
        contextSwitchInputSent = true
        send(mapOf("type" to "context_switch:input", "prompt_id" to promptId))
    }

    /** 意图弹窗开始输入（接管）：首次输入时上报一次；本地重开（promptId 空）不上报 */
    fun notifyIntentTyping(promptId: String) {
        if (promptId.isEmpty()) return
        if (intentInputSent) return
        intentInputSent = true
        send(mapOf("type" to "intent:input", "prompt_id" to promptId))
    }

    fun reportWakeupVerified() {
        send(mapOf("type" to "wakeup:verified"))
        lastContext?.let {
            it.getSystemService(android.app.NotificationManager::class.java).cancel(AnchorNotifications.NOTIF_WAKEUP)
            // 本地乐观解除宵禁；服务器 recordWakeup 后会广播 off，权威对账保持一致
            if (state.value.sunsetPhase != "off") applySunsetPhase(it, "off", 0L, 0L)
        }
        mutableState.update { it.copy(lastWakeupAlarmAt = null) }
    }

    fun scheduleWakeup(context: Context, atMillis: Long) {
        AnchorNotifications.scheduleWakeup(context, atMillis)
        context.getSharedPreferences("anchor", Context.MODE_PRIVATE).edit().putLong("wakeup_at", atMillis).apply()
    }

    suspend fun postCircadian(event: String) {
        send(mapOf("type" to "ingest", "source" to "android", "event_type" to event, "payload" to mapOf("timestamp" to System.currentTimeMillis() / 1000)))
    }

    private fun fetchCurrentState() {
        Thread {
            try {
                val url = java.net.URL("$serverUrl/api/status")
                val conn = url.openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "GET"
                conn.connectTimeout = 3000
                conn.readTimeout = 3000
                val responseCode = conn.responseCode
                if (responseCode == 200) {
                    val response = conn.inputStream.bufferedReader().use { it.readText() }
                    val json = gson.fromJson(response, JsonObject::class.java)
                    val state = json.get("inferred_state")?.asString
                    val serverSunsetPhase = json.get("sunset_phase")?.asString
                    Handler(Looper.getMainLooper()).post {
                        if (state != null) {
                            mutableState.update { it.copy(userState = state) }
                            lastContext?.let { AnchorService.updateForegroundNotification(it) }
                        }
                        // 以服务器权威宵禁状态对账，纠正本地陈旧状态（如隔夜 T0）
                        if (serverSunsetPhase != null) {
                            val local = AnchorRuntime.state.value.sunsetPhase
                            if (serverSunsetPhase != local) {
                                lastContext?.let { ctx ->
                                    // 优先使用服务器返回的稳定 expires_at（与广播同一计算）；
                                    // 无则退回本地估算，winddown 5min / T0 8h
                                    val serverExpiresAt = json.get("expires_at")?.asLong
                                    val expiresAt = when {
                                        serverSunsetPhase == "off" -> 0L
                                        serverExpiresAt != null && serverExpiresAt > 0 -> serverExpiresAt
                                        else -> System.currentTimeMillis() / 1000 + if (serverSunsetPhase == "T0") 8 * 60 * 60 else 5 * 60
                                    }
                                    applySunsetPhase(ctx, serverSunsetPhase, expiresAt, 0L)
                                }
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                // 静默失败，等待 WS 推送
            }
        }.start()
    }

    /** 获取昨日（昨晚写的）和今日（今晚写的）意图，供首页卡片和写意图入口预填 */
    fun fetchIntentions(context: Context) {
        Thread {
            try {
                val yesterday = fetchIntention(context, "yesterday")
                val today = fetchIntention(context, "today")
                Handler(Looper.getMainLooper()).post {
                    mutableState.update { it.copy(yesterdayIntention = yesterday, todayIntention = today) }
                }
            } catch (_: Exception) {
                // 静默失败
            }
        }.start()
    }

    /** 拉取指定相对日期的意图内容（today/yesterday/tomorrow 由服务器按用户时区解析），失败返回 null */
    private fun fetchIntention(context: Context, relativeDate: String): String? {
        return try {
            val conn = java.net.URL("${currentServerUrl(context)}/api/intentions?date=$relativeDate").openConnection() as java.net.HttpURLConnection
            conn.requestMethod = "GET"
            conn.connectTimeout = 3000
            conn.readTimeout = 3000
            if (conn.responseCode == 200) {
                val body = conn.inputStream.bufferedReader().use { it.readText() }
                gson.fromJson(body, JsonObject::class.java)?.get("content")?.asString
            } else null
        } catch (_: Exception) { null }
    }

    /** 拉取今日意图（今晚写的），供「写睡前意图」入口最新预填；回调在主线程 */
    fun fetchTodayIntention(context: Context, callback: (String?) -> Unit) {
        Thread {
            val today = fetchIntention(context, "today")
            Handler(Looper.getMainLooper()).post { callback(today) }
        }.start()
    }

    private fun handleMessage(text: String) {
        val message = gson.fromJson(text, JsonObject::class.java)
        when (message.get("type")?.asString) {
            // 认证成功：清失效标记，进入在线流程（拉状态 + 补发离线队列）
            "auth_ok" -> {
                retryCount = 0
                lastContext?.let {
                    PairingStore.clearPairInvalid(it.getSharedPreferences("anchor", Context.MODE_PRIVATE))
                }
                mutableState.update { it.copy(connected = true) }
                fetchCurrentState()
                flushOfflineQueue()
            }

            // 认证失败：服务器随后会以 4401 关闭连接
            "auth_failed" -> authFailed()

            "ping" -> send(mapOf("type" to "pong"))

            "state:update" -> {
                val newState = message.get("state")?.asString
                mutableState.update { it.copy(userState = newState, connected = true) }
                // 通知服务刷新前台通知文案
                lastContext?.let { AnchorService.updateForegroundNotification(it) }
            }

            "sunset:phase", "sunset:stage" -> {
                val key = if (message.get("type")?.asString == "sunset:stage") "stage" else "phase"
                val phase = message.get(key)?.asString ?: "off"
                // off 消息不携带 expires_at，本地立即过期
                val expiresAt = if (phase == "off") 0L else message.get("expires_at")?.asLong ?: (System.currentTimeMillis() / 1000 + 5 * 60)
                val bedtimeAt = message.get("bedtime_at")?.asLong ?: 0L
                lastContext?.let { applySunsetPhase(it, phase, expiresAt, bedtimeAt) }
                    ?: mutableState.update { it.copy(sunsetPhase = phase) }
            }
            "app:classification" -> {
                val packageName = message.get("package_name")?.asString ?: return
                val high = message.get("high_stimulus")?.asBoolean ?: true
                updateAppClassification(packageName, high)
                if (high && state.value.sunsetPhase == "T15") lastContext?.let { launchCurfew(it) }
            }

            "app:classification_updated" -> {
                // pending（分类中）广播不落缓存，与 sync 行为对齐，等最终结果
                if (message.get("source")?.asString == "pending") return
                val packageName = message.get("package_name")?.asString ?: return
                val high = message.get("high_stimulus")?.asBoolean ?: return
                val isWork = message.get("is_work")?.asBoolean ?: false
                updateAppClassification(packageName, high, isWork)
            }

            "app:classification_deleted" -> {
                val packageName = message.get("package_name")?.asString ?: return
                deleteAppClassification(packageName)
            }

            "notify:ai" -> {
                val ai = message.get("message")?.asString
                if (ai != null) lastContext?.let { AnchorNotifications.showAi(it, ai) }
            }

            "intervention" -> {
                val msg     = message.get("message")?.asString
                val ctx     = message.getAsJsonObject("context")
                val level   = message.get("level")?.asString ?: "strong"
                val detectedApp = ctx?.get("detected_app")?.asString
                mutableState.update { it.copy(
                    interventionMessage = msg,
                    interventionId      = message.get("intervention_id")?.asString,
                    interventionLevel   = level,
                    interventionAction  = message.get("action")?.asString,
                    detectedApp         = detectedApp,
                ) }
                if (msg != null) lastContext?.let { context ->
                    if (level == "soft") AnchorNotifications.showSoftIntervention(context, msg)
                    else AnchorNotifications.showStrongIntervention(context, msg, detectedApp)
                }
            }

            "sunset:config" -> message.getAsJsonObject("config")?.let { config ->
                config.get("target_bedtime_minutes")?.asInt?.let { minutes ->
                    mutableState.update { it.copy(bedtimeMinutes = minutes) }
                }
            }

            "env:switch" -> mutableState.update { it.copy(
                environmentZone  = message.get("zone")?.asString,
                screenColorTemp  = message.get("screen_color_temp")?.asInt,
            ) }

            "capsule:play" -> mutableState.update { it.copy(
                capsuleContent = message.get("content")?.asString,
                capsuleTrigger = message.get("trigger")?.asString,
            ) }

            "time:anchor" -> mutableState.update { it.copy(lastTimeAnchor = message.get("text")?.asString) }

            "behavior:suggestion" -> mutableState.update { it.copy(lastSuggestion = message.get("suggestion")?.asString) }

            "ai:response" -> mutableState.update { it.copy(aiResponse = message.get("response")?.asString) }

            "wakeup:alarm" -> {
                mutableState.update { it.copy(lastWakeupAlarmAt = System.currentTimeMillis()) }
                lastContext?.let { AnchorNotifications.showWakeup(it) }
            }

            "intent:capture" -> {
                val promptId = message.get("prompt_id")?.asString ?: return
                val prompt = message.get("prompt")?.asString ?: return
                val timeout = message.get("timeoutSeconds")?.asInt ?: 60
                intentInputSent = false
                mutableState.update { it.copy(intentCapture = IntentCaptureState(promptId, prompt, timeout)) }
                lastContext?.let { AnchorNotifications.showIntentCapture(it, prompt) }
            }

            // 其他端开始输入（接管）：仅关弹窗语义（同 skipped/expired），通知重开入口保留；
            // 本端输入中（intentInputSent）则忽略自身广播，保留状态等待手动提交/跳过
            "intent:typing" -> {
                if (intentInputSent) return
                mutableState.update { s -> s.intentCapture?.let { s.copy(intentCapture = it.copy(promptId = "")) } ?: s }
            }

            "intent:dismiss" -> {
                val reason = message.get("reason")?.asString ?: ""
                if (reason == "answered") {
                    // 当夜已完成：清状态 + 取消通知（重开入口移除）
                    mutableState.update { it.copy(intentCapture = null) }
                    lastContext?.let { AnchorNotifications.cancelIntentCapture(it) }
                } else {
                    // skipped/expired：仅关弹窗语义，通知保留作重开入口；本地转入重开模式
                    mutableState.update { s -> s.intentCapture?.let { s.copy(intentCapture = it.copy(promptId = "")) } ?: s }
                }
            }

            "context_switch:prompt" -> {
                val promptId    = message.get("prompt_id")?.asString
                val timeout     = message.get("timeoutSeconds")?.asLong ?: 15L
                val placeholder = message.get("placeholder")?.asString
                if (promptId != null) {
                    contextSwitchInputSent = false
                    mutableState.update { it.copy(
                        contextSwitchPromptId    = promptId,
                        contextSwitchPlaceholder = placeholder,
                        contextSwitchDeadline    = System.currentTimeMillis() / 1000 + timeout,
                    ) }
                    lastContext?.let { AnchorNotifications.showContextSwitch(it) }
                }
            }

            // 其他端开始输入（接管）：关闭本端弹窗（未输入时）；
            // 本端输入中（contextSwitchInputSent）则忽略自身广播，保留状态等待手动提交/跳过
            "context_switch:typing" -> {
                val promptId = message.get("prompt_id")?.asString
                if (promptId != null && promptId == state.value.contextSwitchPromptId && !contextSwitchInputSent) {
                    mutableState.update { it.copy(contextSwitchPromptId = null, contextSwitchPlaceholder = null, contextSwitchDeadline = 0) }
                    lastContext?.let { AnchorNotifications.cancelContextSwitch(it) }
                }
            }

            "context_switch:dismiss" -> {
                val promptId = message.get("prompt_id")?.asString
                if (promptId != null && promptId == state.value.contextSwitchPromptId) {
                    mutableState.update { it.copy(contextSwitchPromptId = null, contextSwitchPlaceholder = null, contextSwitchDeadline = 0) }
                    lastContext?.let { AnchorNotifications.cancelContextSwitch(it) }
                }
            }

            "intent:confirm" -> {
                val date = message.get("date")?.asString ?: return
                val content = message.get("content")?.asString ?: return
                mutableState.update { it.copy(intentConfirm = IntentConfirmState(date, content)) }
                // 晨间确认非静默通知（未经过 WakeupActivity 时兜底可见）
                lastContext?.let { AnchorNotifications.showIntentConfirm(it, date, content) }
            }

            "sleep:confirm-request" -> {
                val confirmUntil = message.get("confirm_until")?.asLong ?: (System.currentTimeMillis() / 1000 + 15 * 60)
                mutableState.update { it.copy(sleepConfirmUntil = confirmUntil) }
                lastContext?.let { AnchorNotifications.showSleepConfirm(it, confirmUntil) }
            }

            "sleep:confirm-cancel" -> {
                mutableState.update { it.copy(sleepConfirmUntil = null) }
                lastContext?.let { AnchorNotifications.cancelSleepConfirm(it) }
            }

            "error" -> {
                val code = message.get("code")?.asString
                val msg = message.get("message")?.asString
                if (code == "DECRYPT_FAILED" && msg != null) {
                    mutableState.update { it.copy(configError = msg, connected = false) }
                    lastContext?.let { AnchorNotifications.showAi(it, "⚠ 配置错误: $msg") }
                }
            }
        }
    }

    /** 三态写入：is_work 与 high 互斥，每态恰好一个 true 键（与 AppsScreen/AccessibilityService 守卫约定一致） */
    private fun updateAppClassification(packageName: String, highStimulus: Boolean, isWork: Boolean = false) {
        lastContext?.getSharedPreferences("anchor", Context.MODE_PRIVATE)?.edit()?.apply {
            putBoolean("classified_high_$packageName", highStimulus && !isWork)
            putBoolean("classified_low_$packageName", !highStimulus && !isWork)
            putBoolean("classified_work_$packageName", isWork)
            apply()
        }
        mutableClassificationVersion.update { it + 1 }
    }

    private fun deleteAppClassification(packageName: String) {
        lastContext?.getSharedPreferences("anchor", Context.MODE_PRIVATE)?.edit()?.apply {
            remove("classified_high_$packageName")
            remove("classified_low_$packageName")
            remove("classified_work_$packageName")
            remove("classified_name_$packageName")
            apply()
        }
        mutableClassificationVersion.update { it + 1 }
    }
}





