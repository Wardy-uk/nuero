package uk.nickward.sara.sensor

import android.content.Context

/**
 * Configuration, in the app's private storage.
 *
 * ⚠ The IRK is the key that can track Nick's Watch. It is typed into the tablet and
 * lives only in this app's private preferences: never in the repo, never in the APK,
 * never in a log line, never shown back on screen. Same rule as `/etc/sara-watch.env`.
 */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("sara_sensor", Context.MODE_PRIVATE)

    var room: String
        get() = prefs.getString("room", "study") ?: "study"
        set(v) = prefs.edit().putString("room", v.trim()).apply()

    var pushUrl: String
        get() = prefs.getString("push_url", "") ?: ""
        set(v) = prefs.edit().putString("push_url", v.trim()).apply()

    var token: String
        get() = prefs.getString("token", "") ?: ""
        set(v) = prefs.edit().putString("token", v.trim()).apply()

    var irkHex: String
        get() = prefs.getString("irk", "") ?: ""
        set(v) = prefs.edit().putString("irk", v.trim().lowercase()).apply()

    /** Per sensor, measured from this sensor's own readings — see the Pi's comment. */
    var inRoomRssi: Int
        get() = prefs.getInt("in_room_rssi", -80)
        set(v) = prefs.edit().putInt("in_room_rssi", v).apply()

    /** Whether the service should be running — read on boot. */
    var enabled: Boolean
        get() = prefs.getBoolean("enabled", false)
        set(v) = prefs.edit().putBoolean("enabled", v).apply()
}
