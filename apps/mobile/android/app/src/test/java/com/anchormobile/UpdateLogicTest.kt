package com.anchormobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateLogicTest {

    @Test
    fun isNewerComparesSemver() {
        assertTrue(UpdateLogic.isNewer("1.2.3", "1.2.2"))
        assertTrue(UpdateLogic.isNewer("2.0.0", "1.9.9"))
        assertTrue(UpdateLogic.isNewer("1.3.0", "1.2.9"))
        assertTrue(UpdateLogic.isNewer("v1.0.1", "1.0.0"))
        assertTrue(UpdateLogic.isNewer("1.0.0", "0.9"))
        assertFalse(UpdateLogic.isNewer("1.2.2", "1.2.3"))
        assertFalse(UpdateLogic.isNewer("1.2.3", "1.2.3"))
        assertFalse(UpdateLogic.isNewer("1.2.3", "2.0.0"))
        assertFalse(UpdateLogic.isNewer("abc", "1.0.0"))
        assertFalse(UpdateLogic.isNewer("1.0.0", "abc"))
        assertFalse(UpdateLogic.isNewer("1.2.3-beta", "1.2.3"))
    }

    @Test
    fun parseVersionToleratesPrefixAndMissingSegments() {
        assertEquals(Triple(1, 2, 3), UpdateLogic.parseVersion("v1.2.3"))
        assertEquals(Triple(1, 2, 0), UpdateLogic.parseVersion("1.2"))
        assertEquals(Triple(1, 0, 0), UpdateLogic.parseVersion("v1"))
        assertNull(UpdateLogic.parseVersion(""))
        assertNull(UpdateLogic.parseVersion("a.b.c"))
    }

    @Test
    fun parseLatestReleaseFindsMobileApkAsset() {
        val body = """
            {
              "tag_name": "v1.2.3",
              "assets": [
                { "name": "anchor-desktop-1.2.3-windows-x64.exe", "browser_download_url": "https://x/d.exe" },
                { "name": "anchor-mobile-1.2.3-debug.apk", "browser_download_url": "https://x/m.apk" }
              ]
            }
        """.trimIndent()
        val info = UpdateLogic.parseLatestRelease(body)!!
        assertEquals("1.2.3", info.version)
        assertEquals("v1.2.3", info.tag)
        assertEquals("https://x/m.apk", info.apkUrl)
    }

    @Test
    fun parseLatestReleaseAcceptsApkWithoutDebugSuffix() {
        val body = """
            {
              "tag_name": "v1.2.3",
              "assets": [
                { "name": "anchor-mobile-1.2.3.apk", "browser_download_url": "https://x/m.apk" }
              ]
            }
        """.trimIndent()
        val info = UpdateLogic.parseLatestRelease(body)!!
        assertEquals("1.2.3", info.version)
        assertEquals("https://x/m.apk", info.apkUrl)
    }

    @Test
    fun parseLatestReleaseRejectsNonReleaseTag() {
        val body = """
            { "tag_name": "desktop-v1.2.3", "assets": [] }
        """.trimIndent()
        assertNull(UpdateLogic.parseLatestRelease(body))
        val legacyMobile = """
            { "tag_name": "mobile-v1.2.3", "assets": [] }
        """.trimIndent()
        assertNull(UpdateLogic.parseLatestRelease(legacyMobile))
    }

    @Test
    fun parseLatestReleaseRequiresApkAsset() {
        val body = """
            {
              "tag_name": "v1.2.3",
              "assets": [
                { "name": "SHA256SUMS", "browser_download_url": "https://x/sums" }
              ]
            }
        """.trimIndent()
        assertNull(UpdateLogic.parseLatestRelease(body))
    }

    @Test
    fun shouldCheckThrottlesToOncePerDay() {
        val now = 1_000_000_000L
        assertTrue(UpdateLogic.shouldCheck(now, 0L))
        assertTrue(UpdateLogic.shouldCheck(now, now - UpdateLogic.CHECK_INTERVAL_MS))
        assertFalse(UpdateLogic.shouldCheck(now, now - UpdateLogic.CHECK_INTERVAL_MS + 1))
        assertFalse(UpdateLogic.shouldCheck(now, now))
    }
}
