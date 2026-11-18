package com.anchormobile

import android.content.Context
import android.os.Build
import com.google.gson.Gson
import com.google.gson.JsonObject
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.Locale
import java.util.concurrent.TimeUnit

/** 配对结果：成功携带服务器下发的凭证；失败透出服务端 {error} 文案 */
sealed interface PairResult {
    data class Success(
        val token: String,
        val dataKey: String,
        val serverVersion: String,
        val deviceId: Long,
    ) : PairResult

    data class Failure(val error: String) : PairResult
}

/** 可单测的纯逻辑：配对码规范化 / 默认设备名 / 已配对判定 / 请求与响应构造 */
object PairingLogic {
    const val DEVICE_NAME_MAX = 64

    /** 规范化配对码：去空白 + 大写 */
    fun normalizeCode(code: String): String = code.trim().uppercase(Locale.ROOT)

    /** 默认设备名：「Android · 厂商 型号」，截断 64 字符 */
    fun defaultDeviceName(manufacturer: String, model: String): String =
        "Android · $manufacturer $model".take(DEVICE_NAME_MAX)

    /** 已配对判定：有 token 且未被标记失效（pair_invalid 为运行时标志，重新配对/收到 auth_ok 时清除） */
    fun isPaired(token: String?, pairInvalid: Boolean): Boolean =
        !token.isNullOrEmpty() && !pairInvalid

    /** 配对请求 JSON 体（纯函数，便于单测） */
    fun buildRequestJson(code: String, deviceName: String, clientVersion: String): String {
        val obj = JsonObject().apply {
            addProperty("code", normalizeCode(code))
            addProperty("deviceName", deviceName.trim())
            addProperty("clientVersion", clientVersion)
        }
        return Gson().toJson(obj)
    }

    /** 解析配对成功响应；缺 token/dataKey 返回 null（调用方视为失败） */
    fun parseSuccessResponse(body: String): PairResult.Success? {
        return try {
            val obj = Gson().fromJson(body, JsonObject::class.java)
            val token = obj.get("token")?.asString
            val dataKey = obj.get("dataKey")?.asString
            if (token.isNullOrEmpty() || dataKey.isNullOrEmpty()) return null
            PairResult.Success(
                token = token,
                dataKey = dataKey,
                serverVersion = obj.get("serverVersion")?.asString ?: "",
                deviceId = obj.get("deviceId")?.asLong ?: 0L,
            )
        } catch (e: Exception) {
            null
        }
    }

    /** 解析失败响应中的 {error} 文案（取不到返回空串） */
    fun parseErrorMessage(body: String?): String {
        if (body.isNullOrEmpty()) return ""
        return try {
            Gson().fromJson(body, JsonObject::class.java)?.get("error")?.asString ?: ""
        } catch (e: Exception) {
            ""
        }
    }
}

/**
 * 配对流程：POST /api/pair 凭一次性配对码换取设备 token 与上行数据密钥。
 * 成功后由调用方写 prefs（token/data_key 下发覆盖、device_name、paired_at）并重连 WS。
 */
object PairingClient {
    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    suspend fun pair(serverUrl: String, code: String, deviceName: String, clientVersion: String): PairResult =
        withContext(Dispatchers.IO) {
            val base = serverUrl.trim().trimEnd('/')
            if (base.isEmpty()) return@withContext PairResult.Failure("请填写服务器地址")
            val body = PairingLogic.buildRequestJson(code, deviceName, clientVersion)
                .toRequestBody("application/json; charset=utf-8".toMediaType())
            val request = Request.Builder().url("$base/api/pair").post(body).build()
            val response = try {
                client.newCall(request).execute()
            } catch (e: Exception) {
                return@withContext PairResult.Failure("无法连接服务器，请检查服务器地址")
            }
            response.use { resp ->
                val text = runCatching { resp.body?.string() }.getOrNull()
                when {
                    resp.isSuccessful -> PairingLogic.parseSuccessResponse(text ?: "")
                        ?: PairResult.Failure("服务器响应缺少凭证，请稍后重试")
                    else -> {
                        val message = PairingLogic.parseErrorMessage(text)
                        when (resp.code) {
                            401 -> PairResult.Failure(message.ifEmpty { "配对码无效或已过期" })
                            429 -> PairResult.Failure(message.ifEmpty { "配对请求过于频繁，请稍后再试" })
                            400 -> PairResult.Failure(message.ifEmpty { "配对参数错误" })
                            else -> PairResult.Failure(message.ifEmpty { "配对失败（HTTP ${resp.code}）" })
                        }
                    }
                }
            }
        }
}

/** 配对配置的 prefs 存取（SharedPreferences "anchor"），配合 PairingLogic 判定 */
object PairingStore {
    private const val KEY_TOKEN = "token"
    private const val KEY_DEVICE_NAME = "device_name"
    private const val KEY_PAIRED_AT = "paired_at"
    private const val KEY_PAIR_INVALID = "pair_invalid"

    fun token(prefs: android.content.SharedPreferences): String? =
        prefs.getString(KEY_TOKEN, null)

    fun deviceName(prefs: android.content.SharedPreferences): String? =
        prefs.getString(KEY_DEVICE_NAME, null)

    fun isPaired(prefs: android.content.SharedPreferences): Boolean =
        PairingLogic.isPaired(token(prefs), prefs.getBoolean(KEY_PAIR_INVALID, false))

    fun isPaired(context: Context): Boolean = isPaired(prefs(context))

    fun markPairInvalid(prefs: android.content.SharedPreferences) {
        prefs.edit().putBoolean(KEY_PAIR_INVALID, true).apply()
    }

    fun clearPairInvalid(prefs: android.content.SharedPreferences) {
        prefs.edit().putBoolean(KEY_PAIR_INVALID, false).apply()
    }

    /** 配对成功落库：token/data_key 用下发值覆盖，清 pair_invalid，记录设备名与时间 */
    fun applyPairSuccess(prefs: android.content.SharedPreferences, result: PairResult.Success, deviceName: String, serverUrl: String) {
        prefs.edit()
            .putString(KEY_TOKEN, result.token)
            .putString("data_key", result.dataKey)
            .putString(KEY_DEVICE_NAME, deviceName.trim())
            .putLong(KEY_PAIRED_AT, System.currentTimeMillis())
            .putString("server_url", serverUrl)
            .putBoolean(KEY_PAIR_INVALID, false)
            .apply()
    }

    private fun prefs(context: Context): android.content.SharedPreferences =
        context.getSharedPreferences("anchor", Context.MODE_PRIVATE)

    /** 设备默认名（读系统字段） */
    fun defaultDeviceName(): String = PairingLogic.defaultDeviceName(Build.MANUFACTURER, Build.MODEL)
}
