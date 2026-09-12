package uk.nickward.sara.sensor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ⚠ Measured on the bedroom P30 (12 Sep 2026): 101 scan restarts, and the sensor
 * permanently "still filling the first window" — no usable verdict for that room.
 *
 * The loop: Android silently returns NO RESULTS to an app that starts more than five
 * scans in 30 seconds. No results reads here as a deaf radio, and a deaf radio used to
 * trigger another restart — which is another start, which keeps the throttle on. The
 * Pi sensors never hit it because the throttle is Android's.
 *
 * So each failed attempt waits twice as long: a wedged radio is still recovered, and a
 * throttled one is left alone long enough for the throttle to lift.
 */
class DeafBackoffTest {
    @Test fun theFirstWaitIsTheBaseWindow() {
        assertEquals(SensorService.DEAF_RESTART_MS, SensorService.deafWaitMs(0))
    }

    @Test fun eachFailedAttemptWaitsTwiceAsLong() {
        assertEquals(SensorService.DEAF_RESTART_MS * 2, SensorService.deafWaitMs(1))
        assertEquals(SensorService.DEAF_RESTART_MS * 4, SensorService.deafWaitMs(2))
    }

    @Test fun itIsCappedRatherThanGrowingForever() {
        assertEquals(SensorService.DEAF_BACKOFF_MAX_MS, SensorService.deafWaitMs(20))
        assertTrue(SensorService.deafWaitMs(8) <= SensorService.DEAF_BACKOFF_MAX_MS)
    }

    @Test fun aNegativeCountIsTreatedAsTheFirstAttempt() {
        assertEquals(SensorService.DEAF_RESTART_MS, SensorService.deafWaitMs(-3))
    }

    // ⚠ The restart gap must sit outside Android's own throttle window (5 starts in
    // 30s), or the app can still throttle itself without ever being "deaf".
    @Test fun theMinimumGapBetweenStartsIsGenerousEnoughToDodgeTheThrottle() {
        assertTrue("a 30s window allows 5 starts; ${SensorService.MIN_START_GAP_MS}ms is too eager",
            SensorService.MIN_START_GAP_MS >= 10_000L)
    }
}
