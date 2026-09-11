package uk.nickward.sara.sensor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProvisionTest {
    private val irk = "000102030405060708090A0B0C0D0E0F"

    @Test fun aFullProvisionIsAcceptedAndNormalised() {
        val r = Provision.validate("bedroom", "http://192.168.1.16:3005/api/presence/sensor", "", irk, -75)
        assertTrue(r.errors.isEmpty())
        assertEquals("bedroom", r.room)
        assertEquals("000102030405060708090a0b0c0d0e0f", r.irkHex)
        assertEquals(-75, r.rssi)
    }

    @Test fun anEmptyUrlIsListenOnlyNotAnError() {
        val r = Provision.validate(null, "", null, null, null)
        assertTrue(r.errors.isEmpty())
        assertEquals("", r.url)
        assertTrue(r.summary().contains("listen only"))
    }

    @Test fun omittedFieldsAreLeftAlone() {
        val r = Provision.validate(null, null, null, null, null)
        assertNull(r.room); assertNull(r.url); assertNull(r.irkHex); assertNull(r.rssi)
        assertEquals("nothing", r.summary())
    }

    @Test fun badValuesAreRefusedByNameAndNotApplied() {
        val r = Provision.validate("Bed Room", "ftp://x", null, "1234", 12)
        assertNull(r.room); assertNull(r.url); assertNull(r.irkHex); assertNull(r.rssi)
        assertEquals(4, r.errors.size)
    }

    @Test fun theSummaryNeverContainsTheIrkOrToken() {
        val r = Provision.validate("study", null, "secret-token", irk, null)
        val s = r.summary()
        assertFalse(s.contains(irk, ignoreCase = true))
        assertFalse(s.contains("secret-token"))
        assertTrue(s.contains("irk set"))
    }
}
