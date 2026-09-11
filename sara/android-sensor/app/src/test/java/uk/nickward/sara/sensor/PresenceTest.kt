package uk.nickward.sara.sensor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The rules the study sensor must share with the Pi sensors, because the backend
 * treats every room's own sensor the same way.
 */
class PresenceTest {
    private val iso = "2026-09-11T10:00:00Z"

    /** Past the 20s warm-up, with a background device chattering throughout. */
    private fun warm(): Presence = Presence("study").apply {
        scanStarted(0)
        for (t in 0L..25_000L step 500) onAdvert(t, "11:22:33:44:55:66", -70, isWatch = false)
    }

    @Test fun deafIsUnknownNeverAbsent() {
        val p = Presence("study").apply { scanStarted(0) }
        val r = p.reading(30_000, Presence.SCOPE_ALL, iso)
        assertEquals("unknown", r["status"])
        assertNull("a deaf radio must not say he is not here", r["inRoom"])
        assertEquals(false, r["healthy"])
    }

    @Test fun warmingUpIsUnknown() {
        val p = Presence("study").apply {
            scanStarted(0)
            onAdvert(1_000, "11:22:33:44:55:66", -70, false)
        }
        val r = p.reading(5_000, Presence.SCOPE_ALL, iso)
        assertEquals("unknown", r["status"])
        assertEquals("still filling the first window", r["why"])
    }

    @Test fun healthyAndHearingNothingIsARealNo() {
        val r = warm().reading(25_000, Presence.SCOPE_ALL, iso)
        assertEquals("absent", r["status"])
        assertEquals("a healthy sensor hearing nothing is an answer", false, r["inRoom"])
    }

    @Test fun nearWatchIsPresentAndInRoom() {
        val p = warm()
        for (t in 6_000L..25_000L step 1_000) p.onAdvert(t, "6A:5B:C3:34:B6:34", -60, isWatch = true)
        val r = p.reading(25_000, Presence.SCOPE_ALL, iso)
        assertEquals("present", r["status"])
        assertEquals(true, r["inRoom"])
        assertEquals(-60, r["rssiMedian"])
    }

    @Test fun audibleThroughTheWallIsPresentButNotInRoom() {
        val p = warm()
        for (t in 6_000L..25_000L step 1_000) p.onAdvert(t, "6A:5B:C3:34:B6:34", -88, isWatch = true)
        val r = p.reading(25_000, Presence.SCOPE_ALL, iso)
        assertEquals("present", r["status"])
        assertEquals(false, r["inRoom"])
    }

    @Test fun aTrickleBelowTheMinimumRateIsAbsent() {
        val p = warm()
        p.onAdvert(20_000, "6A:5B:C3:34:B6:34", -60, isWatch = true)  // 1 in 20s = 0.05/s
        assertEquals("absent", p.reading(25_000, Presence.SCOPE_ALL, iso)["status"])
    }

    @Test fun oldAdvertsAgeOutOfTheWindow() {
        val p = warm()
        for (t in 1_000L..4_000L step 250) p.onAdvert(t, "6A:5B:C3:34:B6:34", -60, isWatch = true)
        assertEquals("absent", p.reading(25_000, Presence.SCOPE_ALL, iso)["status"])
    }

    @Test fun aKnownFaultForcesUnknownWithItsReason() {
        val p = warm()
        for (t in 6_000L..25_000L step 1_000) p.onAdvert(t, "6A:5B:C3:34:B6:34", -60, isWatch = true)
        val r = p.reading(25_000, Presence.SCOPE_ALL, iso, fault = "Location is off")
        assertEquals("unknown", r["status"])
        assertEquals("Location is off", r["why"])
        assertNull(r["inRoom"])
        assertEquals(false, r["healthy"])
    }

    @Test fun theNarrowedScreenOffScanSaysSoWhenSilent() {
        val p = Presence("study").apply { scanStarted(0) }
        val r = p.reading(30_000, Presence.SCOPE_APPLE, iso)
        assertEquals("unknown", r["status"])
        assertEquals("apple", r["scanScope"])
        assertEquals(true, (r["why"] as String).contains("screen off"))
    }

    @Test fun readingCarriesEveryFieldTheBackendStores() {
        val r = warm().reading(25_000, Presence.SCOPE_ALL, iso)
        for (k in listOf("room", "status", "healthy", "inRoom", "rate", "rssiMedian", "backgroundDevices", "why", "at", "resets")) {
            assertEquals("missing $k", true, r.containsKey(k))
        }
        assertEquals("study", r["room"])
    }

    @Test fun medianMatchesPythonsIntOfStatisticsMedian() {
        assertNull(Presence.median(emptyList()))
        assertEquals(-60, Presence.median(listOf(-70, -60, -50)))
        assertEquals(-67, Presence.median(listOf(-70, -65)))     // -67.5 truncates toward zero
        assertEquals(-60, Presence.median(listOf(-50, -60, -61, -80)))  // -60.5 -> -60
    }
}
