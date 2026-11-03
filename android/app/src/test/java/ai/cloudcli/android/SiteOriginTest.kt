package ai.cloudcli.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SiteOriginTest {

    @Test
    fun keepsHttpsOrigin() {
        assertEquals("https://cloud.example.com", SiteOrigin.normalize("https://cloud.example.com"))
    }

    @Test
    fun keepsNonDefaultPortAndDropsDefaultPort() {
        assertEquals("https://cloud.example.com:8443", SiteOrigin.normalize("https://cloud.example.com:8443"))
        assertEquals("https://cloud.example.com", SiteOrigin.normalize("https://cloud.example.com:443"))
        assertEquals("http://cloud.example.com", SiteOrigin.normalize("http://cloud.example.com:80"))
    }

    @Test
    fun lowercasesHostAndTrimsRootPath() {
        assertEquals("https://cloud.example.com", SiteOrigin.normalize("  HTTPS://Cloud.Example.COM/  "))
    }

    @Test
    fun rejectsUnsupportedSchemes() {
        assertNull(SiteOrigin.normalize("ftp://cloud.example.com"))
        assertNull(SiteOrigin.normalize("javascript:alert(1)"))
        assertNull(SiteOrigin.normalize("cloud.example.com"))
    }

    @Test
    fun rejectsMissingHost() {
        assertNull(SiteOrigin.normalize("https://"))
        assertNull(SiteOrigin.normalize("https:///path"))
    }

    @Test
    fun rejectsCredentialsPathQueryAndFragment() {
        assertNull(SiteOrigin.normalize("https://" + "user" + "@" + "cloud.example.com"))
        assertNull(SiteOrigin.normalize("https://cloud.example.com/app"))
        assertNull(SiteOrigin.normalize("https://cloud.example.com/?a=1"))
        assertNull(SiteOrigin.normalize("https://cloud.example.com/#x"))
    }

    @Test
    fun rejectsOutOfRangePort() {
        assertNull(SiteOrigin.normalize("https://cloud.example.com:70000"))
    }

    @Test
    fun detectsSingleHttpUrl() {
        assertTrue(SiteOrigin.isSingleHttpUrl("https://example.com/a/b?c=1"))
        assertTrue(SiteOrigin.isSingleHttpUrl("http://example.com"))
        assertFalse(SiteOrigin.isSingleHttpUrl("read https://example.com"))
        assertFalse(SiteOrigin.isSingleHttpUrl("mailto:a@b.c"))
        assertFalse(SiteOrigin.isSingleHttpUrl(""))
    }

    @Test
    fun mapsOriginToWebSocketOrigin() {
        assertEquals("wss://cloud.example.com:8443", SiteOrigin.wsOrigin("https://cloud.example.com:8443"))
        assertEquals("ws://cloud.example.com", SiteOrigin.wsOrigin("http://cloud.example.com"))
    }
}
