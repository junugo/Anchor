package com.anchormobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CryptoTest {

    @Test
    fun roundtrip() {
        val plaintext = """{"type":"ingest","source":"android","event_type":"app_foreground","payload":{"package":"wechat"},"logged_at":1750000000}"""
        val envelope = Crypto.encryptEnvelope(plaintext, Crypto.DEFAULT_DATA_KEY)
        assertTrue(envelope.startsWith("""{"enc":true,"v":1,"data":"""))
        assertEquals(plaintext, Crypto.decryptEnvelope(envelope, Crypto.DEFAULT_DATA_KEY))
    }

    @Test
    fun randomIvEachTime() {
        val a = Crypto.encryptEnvelope("hello anchor", Crypto.DEFAULT_DATA_KEY)
        val b = Crypto.encryptEnvelope("hello anchor", Crypto.DEFAULT_DATA_KEY)
        assertNotEquals(a, b)
    }

    @Test
    fun wrongKeyFails() {
        val envelope = Crypto.encryptEnvelope("secret", Crypto.DEFAULT_DATA_KEY)
        try {
            Crypto.decryptEnvelope(envelope, "wrong-key")
            throw AssertionError("应解密失败")
        } catch (_: Exception) {
            // AEAD tag 校验失败即异常，符合预期
        }
    }

    @Test
    fun decryptsTsCiphertext() {
        // 由 packages/utils encryptEnvelope（WebCrypto）生成的一次性密文：wire 兼容验证
        val envelope = """{"enc":true,"v":1,"data":"r9z25TxQ3c3i/lNPxOTeqWqSS2M/LSOhax2VaWqUcHyADmmxW+zHTkwpD24TedE8iikrBMW9WqBnSqU6XCrxOoPPceH2aE7iTXXRGisvv+4I3iDM2MVmKWnSV8VAF/JdwO9UPbZmLzyrgcXXfqT7UGwF5Eafwcm0ZB+EuN+G3Q8coDYV7QCxdREXOW7phFcpNxI54SwH7c2eXD/1vl+4VFi+OfngUWd3X+PdXEMTxhm/Yn+w4pWbVSEN/Qf+DyFcQEy9l1DwW0u40+1o3YAewx0="}"""
        val plaintext = Crypto.decryptEnvelope(envelope, Crypto.DEFAULT_DATA_KEY)
        assertTrue("明文: $plaintext", plaintext.contains("window_focus"))    }
}
