package com.anchormobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CryptoTest {
    // 测试向量：固定口令，仅用于 wire 兼容验证（非运行时回退）
    private val TEST_KEY = "anchor-dev-data-key"

    @Test
    fun roundtrip() {
        val plaintext = """{"type":"ingest","source":"android","event_type":"app_foreground","payload":{"package":"wechat"},"logged_at":1750000000}"""
        val envelope = Crypto.encryptEnvelope(plaintext, TEST_KEY)
        assertTrue(envelope.startsWith("""{"enc":true,"v":1,"data":"""))
        assertEquals(plaintext, Crypto.decryptEnvelope(envelope, TEST_KEY))
    }

    @Test
    fun randomIvEachTime() {
        val a = Crypto.encryptEnvelope("hello anchor", TEST_KEY)
        val b = Crypto.encryptEnvelope("hello anchor", TEST_KEY)
        assertNotEquals(a, b)
    }

    @Test
    fun wrongKeyFails() {
        val envelope = Crypto.encryptEnvelope("secret", TEST_KEY)
        try {
            Crypto.decryptEnvelope(envelope, "wrong-key")
            throw AssertionError("应解密失败")
        } catch (_: Exception) {
            // AEAD tag 校验失败即异常，符合预期
        }
    }

    @Test
    fun decryptsTsCiphertext() {
        // 由 packages/utils encryptJson（WebCrypto）生成的一次性密文：wire 兼容验证
        // 生成方式：encryptJson({...event_type:"window_focus"...}, TEST_KEY)
        val envelope = """{"enc":true,"v":1,"data":"BNoTCnPlo3GMml3GvifSAt50ASNMn5uWBqoZM1Pj+Ee9Z0Jcq5iu1kq2eWJaj7XYQyMVzsERPB/pS5pb2yIAeue97piv8pqIQJECwPPPp6i8DuhbglIM2K0c6oaKA6kgHWaZs4D042FxJEIvVUH+vy9KuNDzpNZijFb0eGUGm0cu2S7i3ojq1c9u0w6ITA2jvVH7"}"""
        val plaintext = Crypto.decryptEnvelope(envelope, TEST_KEY)
        assertTrue("明文: $plaintext", plaintext.contains("window_focus"))    }

    @Test
    fun blankKeyThrows() {
        // 无密钥（未配对/未配置）必须抛错，调用方负责跳过上报
        try {
            Crypto.encryptEnvelope("x", null)
            throw AssertionError("空密钥应抛异常")
        } catch (e: IllegalStateException) {
            // 符合预期
        }
        try {
            Crypto.encryptEnvelope("x", "   ")
            throw AssertionError("空白密钥应抛异常")
        } catch (e: IllegalStateException) {
            // 符合预期
        }
    }
}
