package com.anchormobile

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.anchormobile.R
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.reflect.TypeToken
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

// ─── 数据结构 ───────────────────────────────────────────────────────────────

data class ChatMessage(
    val role: String,       // "user" | "assistant"
    val content: String,
    val createdAt: Long = 0L,
)

data class SessionSummary(
    val sessionId: String,
    val createdAt: Long,
    val lastMessageAt: Long,
    val title: String?,
    val preview: String?,
)

data class ChatUiState(
    val sessionId: String? = null,
    val messages: List<ChatMessage> = emptyList(),
    val input: String = "",
    val streaming: Boolean = false,
    val loading: Boolean = true,
    val drawerOpen: Boolean = false,
    val sessions: List<SessionSummary> = emptyList(),
    val loadingSessions: Boolean = false,
    val error: String? = null,
)

// ─── ViewModel ──────────────────────────────────────────────────────────────

class ChatViewModel(application: Application) : AndroidViewModel(application) {

    private val gson = Gson()
    private val json = "application/json; charset=utf-8".toMediaType()

    // 使用独立 OkHttpClient 以便设置较长的读超时（SSE 流式响应不会快速结束）
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    private val _state = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = _state

    init {
        loadCurrentSession()
    }

    // ── 工具函数 ───────────────────────────────────────────────────────────

    private fun baseUrl(): String =
        AnchorRuntime.currentServerUrl(getApplication()).trimEnd('/')

    // ── 初始化：获取当前会话（含开场白） ─────────────────────────────────────

    private fun loadCurrentSession() {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                val url = "${baseUrl()}/api/ai/chat/sessions/current"
                val req = Request.Builder().url(url).get().build()
                val result = withContext(Dispatchers.IO) {
                    http.newCall(req).execute().use { res ->
                        if (!res.isSuccessful) return@withContext null
                        res.body?.string()
                    }
                } ?: run {
                    _state.update { it.copy(loading = false, error = getApplication<Application>().applicationContext.getString(R.string.chat_err_connect)) }
                    return@launch
                }
                val obj = gson.fromJson(result, JsonObject::class.java)
                val sessionId = obj.get("sessionId")?.asString ?: return@launch
                val msgs = parseMessages(obj)
                _state.update { it.copy(loading = false, sessionId = sessionId, messages = msgs) }
            } catch (e: Exception) {
                _state.update { it.copy(loading = false, error = getApplication<Application>().applicationContext.getString(R.string.chat_err_connect)) }
            }
        }
    }

    // ── 发送消息（SSE 流式） ──────────────────────────────────────────────────

    fun setInput(text: String) {
        _state.update { it.copy(input = text) }
    }

    fun send() {
        val current = _state.value
        val text = current.input.trim()
        if (text.isBlank() || current.streaming || current.loading || current.sessionId == null) return

        val userMsg = ChatMessage(role = "user", content = text)
        val pendingAssistant = ChatMessage(role = "assistant", content = "")

        // 乐观更新：立即显示用户消息和空 assistant 占位
        _state.update { it.copy(
            input = "",
            streaming = true,
            messages = it.messages + userMsg + pendingAssistant,
        ) }

        viewModelScope.launch(Dispatchers.IO) {
            try {
                // 构造发送给服务器的消息列表（不含 streaming 占位的空 assistant）
                val msgList = (_state.value.messages.dropLast(1)).map { m ->
                    mapOf("role" to m.role, "content" to m.content)
                }
                val body = gson.toJson(mapOf(
                    "sessionId" to current.sessionId,
                    "messages" to msgList,
                )).toRequestBody(json)

                val req = Request.Builder()
                    .url("${baseUrl()}/api/ai/chat")
                    .post(body)
                    .build()

                http.newCall(req).execute().use { res ->
                    if (!res.isSuccessful || res.body == null) {
                        updateLastAssistant(getApplication<Application>().applicationContext.getString(R.string.chat_err_send_fail))
                        return@use
                    }

                    val source = res.body!!.source()
                    var buffer = ""

                    // 逐行读取 SSE，解析 delta.content 追加到最后一条 assistant 消息
                    while (!source.exhausted()) {
                        val line = source.readUtf8Line() ?: break
                        buffer = line

                        if (!buffer.startsWith("data: ")) continue
                        val data = buffer.removePrefix("data: ").trim()
                        if (data == "[DONE]") break

                        try {
                            val chunk = gson.fromJson(data, JsonObject::class.java)
                            val token = chunk
                                ?.getAsJsonArray("choices")
                                ?.get(0)?.asJsonObject
                                ?.getAsJsonObject("delta")
                                ?.get("content")?.asString
                                ?: continue

                            if (token.isNotEmpty()) {
                                _state.update { s ->
                                    val msgs = s.messages.toMutableList()
                                    val last = msgs.lastOrNull() ?: return@update s
                                    msgs[msgs.lastIndex] = last.copy(content = last.content + token)
                                    s.copy(messages = msgs)
                                }
                            }
                        } catch (_: Exception) {
                            // 跳过格式异常的 SSE chunk
                        }
                    }
                }
            } catch (e: Exception) {
                updateLastAssistant(getApplication<Application>().applicationContext.getString(R.string.chat_err_network))
            } finally {
                _state.update { it.copy(streaming = false) }
            }
        }
    }

    // 更新最后一条 assistant 消息内容（用于错误降级）
    private fun updateLastAssistant(text: String) {
        _state.update { s ->
            val msgs = s.messages.toMutableList()
            val last = msgs.lastOrNull() ?: return@update s
            msgs[msgs.lastIndex] = last.copy(content = text)
            s.copy(messages = msgs)
        }
    }

    // ── 抽屉：加载历史会话列表 ────────────────────────────────────────────────

    fun openDrawer() {
        _state.update { it.copy(drawerOpen = true) }
        loadHistory()
    }

    fun closeDrawer() {
        _state.update { it.copy(drawerOpen = false) }
    }

    private fun loadHistory() {
        viewModelScope.launch {
            _state.update { it.copy(loadingSessions = true) }
            try {
                val req = Request.Builder()
                    .url("${baseUrl()}/api/ai/chat/sessions")
                    .get().build()
                val result = withContext(Dispatchers.IO) {
                    http.newCall(req).execute().use { res ->
                        if (!res.isSuccessful) return@withContext null
                        res.body?.string()
                    }
                } ?: return@launch

                val type = object : TypeToken<List<Map<String, Any?>>>() {}.type
                val list: List<Map<String, Any?>> = gson.fromJson(result, type)
                val sessions = list.mapNotNull { m ->
                    val id = m["session_id"] as? String ?: return@mapNotNull null
                    SessionSummary(
                        sessionId = id,
                        createdAt = (m["created_at"] as? Double)?.toLong() ?: 0L,
                        lastMessageAt = (m["last_message_at"] as? Double)?.toLong() ?: 0L,
                        title = m["title"] as? String,
                        preview = m["preview"] as? String,
                    )
                }
                _state.update { it.copy(sessions = sessions) }
            } catch (_: Exception) {
                // 历史加载失败静默处理，不影响当前会话
            } finally {
                _state.update { it.copy(loadingSessions = false) }
            }
        }
    }

    // ── 切换到历史会话 ────────────────────────────────────────────────────────

    fun switchSession(sessionId: String) {
        if (_state.value.streaming) return
        viewModelScope.launch {
            _state.update { it.copy(loading = true, drawerOpen = false) }
            try {
                val req = Request.Builder()
                    .url("${baseUrl()}/api/ai/chat/sessions/$sessionId")
                    .get().build()
                val result = withContext(Dispatchers.IO) {
                    http.newCall(req).execute().use { res ->
                        if (!res.isSuccessful) return@withContext null
                        res.body?.string()
                    }
                } ?: run {
                    _state.update { it.copy(loading = false) }
                    return@launch
                }
                val obj = gson.fromJson(result, JsonObject::class.java)
                val msgs = parseMessages(obj)
                _state.update { it.copy(loading = false, sessionId = sessionId, messages = msgs) }
            } catch (_: Exception) {
                _state.update { it.copy(loading = false) }
            }
        }
    }

    // ── 新建会话 ──────────────────────────────────────────────────────────────

    fun newSession() {
        if (_state.value.streaming) return
        viewModelScope.launch {
            _state.update { it.copy(loading = true, drawerOpen = false, messages = emptyList()) }
            try {
                val req = Request.Builder()
                    .url("${baseUrl()}/api/ai/chat/sessions")
                    .post("{}".toRequestBody(json))
                    .build()
                val result = withContext(Dispatchers.IO) {
                    http.newCall(req).execute().use { res ->
                        if (!res.isSuccessful) return@withContext null
                        res.body?.string()
                    }
                } ?: run {
                    _state.update { it.copy(loading = false, error = getApplication<Application>().applicationContext.getString(R.string.chat_err_create_session)) }
                    return@launch
                }
                val obj = gson.fromJson(result, JsonObject::class.java)
                val sessionId = obj.get("sessionId")?.asString ?: return@launch
                val msgs = parseMessages(obj)
                _state.update { it.copy(loading = false, sessionId = sessionId, messages = msgs) }
            } catch (_: Exception) {
                _state.update { it.copy(loading = false, error = getApplication<Application>().applicationContext.getString(R.string.chat_err_create_session)) }
            }
        }
    }

    // ── 重命名会话 ────────────────────────────────────────────────────────────

    fun renameSession(sessionId: String, title: String) {
        val trimmed = title.trim()
        if (trimmed.isBlank()) return
        viewModelScope.launch {
            try {
                val body = gson.toJson(mapOf("title" to trimmed)).toRequestBody(json)
                val req = Request.Builder()
                    .url("${baseUrl()}/api/ai/chat/sessions/$sessionId")
                    .patch(body)
                    .build()
                val ok = withContext(Dispatchers.IO) {
                    http.newCall(req).execute().use { res -> res.isSuccessful }
                }
                if (ok) {
                    _state.update { s ->
                        s.copy(sessions = s.sessions.map {
                            if (it.sessionId == sessionId) it.copy(title = trimmed) else it
                        })
                    }
                }
            } catch (_: Exception) {
                // 重命名失败静默处理
            }
        }
    }

    // ── 删除会话 ──────────────────────────────────────────────────────────────

    fun deleteSession(sessionId: String) {
        viewModelScope.launch {
            try {
                val req = Request.Builder()
                    .url("${baseUrl()}/api/ai/chat/sessions/$sessionId")
                    .delete()
                    .build()
                val ok = withContext(Dispatchers.IO) {
                    http.newCall(req).execute().use { res -> res.isSuccessful }
                }
                if (!ok) return@launch
                _state.update { s -> s.copy(sessions = s.sessions.filter { it.sessionId != sessionId }) }
                // 删除的是当前会话则自动开启新会话
                if (_state.value.sessionId == sessionId) {
                    newSession()
                }
            } catch (_: Exception) {
                // 删除失败静默处理
            }
        }
    }

    // ── 辅助：解析响应中的 messages 数组 ─────────────────────────────────────

    private fun parseMessages(obj: JsonObject): List<ChatMessage> {
        val arr = obj.getAsJsonArray("messages") ?: return emptyList()
        return arr.mapNotNull { el ->
            val o = el.asJsonObject ?: return@mapNotNull null
            val role = o.get("role")?.asString ?: return@mapNotNull null
            val content = o.get("content")?.asString ?: return@mapNotNull null
            val createdAt = o.get("created_at")?.asLong ?: 0L
            ChatMessage(role = role, content = content, createdAt = createdAt)
        }
    }
}
