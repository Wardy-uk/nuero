package uk.nickward.sara.sensor

/**
 * The whole judgement, as data — a port of `Sensor` in sara/sensor/sara-room-sensor.py.
 *
 * The backend already trusts a room's OWN sensor to decide that room's screen, so this
 * must answer exactly the way the Pi sensors do or the study will behave differently
 * from every other room. The rules carried across unchanged:
 *
 *  - A SCAN THAT HEARS NOTHING IS `unknown`, NEVER `absent`. Health is the background:
 *    every device in earshot, not just the Watch. Zero means the radio is deaf.
 *  - HEARD AT ALL is advert rate over a window; IN THIS ROOM is median RSSI against a
 *    per-sensor threshold. Rate was tried for the second question and was wrong.
 *  - `inRoom` is null ONLY when the sensor could not answer. A healthy sensor hearing
 *    nothing is a real answer ("he is not in this room"), not an absence of one.
 *
 * One addition the Pi does not need: `scanScope`. Android 8.1+ delivers NO results
 * for an unfiltered scan while the screen is off, so with the screen off the scan is
 * narrowed to Apple adverts and the background health signal means "Apple devices
 * audible" instead of "anything audible". That is reported, never hidden — the Pi's
 * own comment warns that narrowing the background silently destroys the health check
 * while appearing to work.
 *
 * PURE: time is passed in (monotonic ms), nothing touches Android.
 */
class Presence(
    private val room: String,
    private val windowMs: Long = 20_000,
    private val healthWindowMs: Long = 45_000,
    private val minRate: Double = 0.2,
    private val inRoomRssi: Int = -80,
) {
    private val watch = ArrayDeque<Pair<Long, Int>>()   // (t, rssi)
    private val background = ArrayDeque<Long>()          // t, ANY device
    private val addresses = HashMap<String, Long>()      // address -> last seen
    private var lastWatchAt: Long? = null
    private var startedAt: Long = 0
    var resets: Int = 0

    @Synchronized
    fun scanStarted(t: Long) {
        startedAt = t
    }

    @Synchronized
    fun onAdvert(t: Long, address: String, rssi: Int, isWatch: Boolean) {
        background.addLast(t)
        addresses[address] = t
        if (isWatch) {
            watch.addLast(t to rssi)
            lastWatchAt = t
        }
    }

    private fun trim(t: Long) {
        while (watch.isNotEmpty() && t - watch.first().first > windowMs) watch.removeFirst()
        while (background.isNotEmpty() && t - background.first() > healthWindowMs) background.removeFirst()
        addresses.entries.removeIf { t - it.value > healthWindowMs }
    }

    /**
     * @param fault set when the sensor KNOWS it cannot hear (Bluetooth off, Location
     *   off, a failed scan start). Forces `unknown` with that reason, as the Pi does
     *   for a stuck adapter.
     */
    @Synchronized
    fun reading(t: Long, scanScope: String, atIso: String, fault: String? = null): LinkedHashMap<String, Any?> {
        trim(t)

        val warming = (t - startedAt) < windowMs
        val healthy = fault == null && background.isNotEmpty()
        val rssis = watch.map { it.second }
        val rate = rssis.size / (windowMs / 1000.0)

        val status: String
        val why: String?
        when {
            fault != null -> { status = "unknown"; why = fault }
            !healthy -> {
                status = "unknown"
                why = if (scanScope == SCOPE_APPLE)
                    "no Apple devices audible with the screen off - cannot tell deaf from empty"
                else
                    "no BLE traffic at all - the radio is deaf, not the room empty"
            }
            warming -> { status = "unknown"; why = "still filling the first window" }
            rate >= minRate -> { status = "present"; why = null }
            else -> { status = "absent"; why = null }
        }

        val median = median(rssis)
        val inRoom: Boolean? = if (status == "unknown") null else (median != null && median >= inRoomRssi)

        return linkedMapOf(
            "room" to room,
            "status" to status,
            "inRoom" to inRoom,
            "inRoomRssi" to inRoomRssi,
            "why" to why,
            "healthy" to healthy,
            "rate" to Math.round(rate * 100) / 100.0,
            "adverts" to rssis.size,
            "rssiMedian" to median,
            "rssiMax" to rssis.maxOrNull(),
            "backgroundAdverts" to background.size,
            "backgroundDevices" to addresses.size,
            "lastSeenS" to lastWatchAt?.let { Math.round((t - it) / 100.0) / 10.0 },
            "windowS" to windowMs / 1000.0,
            "resets" to resets,
            "scanScope" to scanScope,
            "sensor" to "android",
            "at" to atIso,
        )
    }

    companion object {
        const val SCOPE_ALL = "all"
        const val SCOPE_APPLE = "apple"

        /** Python's `int(statistics.median(xs))`: middle pair averaged, truncated toward zero. */
        fun median(xs: List<Int>): Int? {
            if (xs.isEmpty()) return null
            val s = xs.sorted()
            val mid = s.size / 2
            return if (s.size % 2 == 1) s[mid] else ((s[mid - 1] + s[mid]) / 2.0).toInt()
        }
    }
}
