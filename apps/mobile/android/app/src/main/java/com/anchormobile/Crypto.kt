package com.anchormobile

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 上行行为数据加密（AES-256-GCM），与服务器 packages/utils/src/crypto.ts 同规格：
 * - key = SHA-256(passphrase)
 * - 线格式 base64(iv(12B) ‖ ciphertext ‖ tag(16B))
 * - 信封 { "enc": true, "v": 1, "data": base64 }
 */
object Crypto {
    private const val IV_LEN = 12
    private const val TAG_BITS = 128

    /**
     * 上行加密密钥必须已配置（配对成功后由服务器下发）。
     * key 为 null/空白时抛异常，调用方负责处理（如跳过上报）。
     */
    fun requireDataKey(dataKey: String?): String {
        val key = dataKey?.trim().orEmpty()
        if (key.isEmpty()) throw IllegalStateException("数据密钥未配置，请先完成配对")
        return key
    }

    fun encryptEnvelope(plaintext: String, dataKey: String?): String {
        val key = MessageDigest.getInstance("SHA-256").digest(requireDataKey(dataKey).toByteArray(Charsets.UTF_8))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val iv = ByteArray(IV_LEN).also { SecureRandom().nextBytes(it) }
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
        val ct = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        val data = Base64.getEncoder().encodeToString(iv + ct)
        return "{\"enc\":true,\"v\":1,\"data\":\"$data\"}"
    }

    fun keyFingerprint(dataKey: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(dataKey.toByteArray(Charsets.UTF_8))
        return Base64.getEncoder().encodeToString(digest).take(8)
    }

    /** 解密信封（仅测试与自检用） */
    fun decryptEnvelope(envelope: String, dataKey: String): String {
        val obj = com.google.gson.JsonParser.parseString(envelope).asJsonObject
        val key = MessageDigest.getInstance("SHA-256").digest(dataKey.toByteArray(Charsets.UTF_8))
        val raw = Base64.getDecoder().decode(obj.get("data").asString)
        val iv = raw.copyOfRange(0, IV_LEN)
        val ct = raw.copyOfRange(IV_LEN, raw.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
        return String(cipher.doFinal(ct), Charsets.UTF_8)
    }
}
