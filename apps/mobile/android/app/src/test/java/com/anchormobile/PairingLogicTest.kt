package com.anchormobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingLogicTest {

    @Test
    fun normalizeCodeTrimsAndUppercases() {
        assertEquals("ABCD2345", PairingLogic.normalizeCode("  abcd2345 "))
        assertEquals("ABCD2345", PairingLogic.normalizeCode("AbCd2345"))
        assertEquals("", PairingLogic.normalizeCode("   "))
    }

    @Test
    fun defaultDeviceNameFormatAndTruncate() {
        assertEquals("Android · Google Pixel 8", PairingLogic.defaultDeviceName("Google", "Pixel 8"))
        val long = PairingLogic.defaultDeviceName("A".repeat(40), "B".repeat(40))
        assertEquals(PairingLogic.DEVICE_NAME_MAX.toInt(), long.length)
        assertTrue(long.startsWith("Android · "))
    }

    @Test
    fun isPairedRequiresTokenAndNotInvalid() {
        assertFalse(PairingLogic.isPaired(null, false))
        assertFalse(PairingLogic.isPaired("", false))
        assertFalse(PairingLogic.isPaired("tok", true))
        assertTrue(PairingLogic.isPaired("tok", false))
    }

    @Test
    fun buildRequestJsonNormalizesFields() {
        val json = PairingLogic.buildRequestJson(" abcd2345 ", " 我的手机 ", "1.0")
        assertTrue(json.contains("\"code\":\"ABCD2345\""))
        assertTrue(json.contains("\"deviceName\":\"我的手机\""))
        assertTrue(json.contains("\"clientVersion\":\"1.0\""))
    }

    @Test
    fun parseSuccessResponseExtractsFields() {
        val body = """{"token":"tk123","dataKey":"dk","serverVersion":"2.1.0","deviceId":7}"""
        val result = PairingLogic.parseSuccessResponse(body)
        assertEquals("tk123", result!!.token)
        assertEquals("dk", result.dataKey)
        assertEquals("2.1.0", result.serverVersion)
        assertEquals(7L, result.deviceId)
    }

    @Test
    fun parseSuccessResponseRejectsMissingCredentials() {
        assertNull(PairingLogic.parseSuccessResponse("""{"token":"","dataKey":"dk"}"""))
        assertNull(PairingLogic.parseSuccessResponse("""{"token":"tk"}"""))
        assertNull(PairingLogic.parseSuccessResponse("not json"))
    }

    @Test
    fun parseErrorMessageExtractsServerError() {
        assertEquals("配对码无效或已过期", PairingLogic.parseErrorMessage("""{"error":"配对码无效或已过期"}"""))
        assertEquals("", PairingLogic.parseErrorMessage("not json"))
        assertEquals("", PairingLogic.parseErrorMessage(null))
    }
}
