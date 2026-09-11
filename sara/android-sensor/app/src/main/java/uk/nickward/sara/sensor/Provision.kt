package uk.nickward.sara.sensor

/**
 * Settings sent over ADB instead of typed through the screen.
 *
 * ⚠ WHY (11 Sep 2026, the bedroom Huawei P30 lite): typing the Watch IRK in with
 * `adb shell input text` went through SwiftKey — the only keyboard on the phone — which
 * dropped characters and swallowed the keys meant to dismiss it, and a dropped ADB
 * connection mid-script typed the key into the wrong, VISIBLE field. Screen automation
 * is the wrong tool for a secret. So a device is provisioned with one broadcast:
 *
 *   adb shell am broadcast -a uk.nickward.sara.sensor.PROVISION \
 *     -n uk.nickward.sara.sensor/.ProvisionReceiver \
 *     --es room bedroom --es url http://… --es irk <hex> --ei rssi -80 --ez start true
 *
 * The receiver requires android.permission.DUMP, which the ADB shell holds and an
 * installed app cannot, so nothing on the device can reconfigure the sensor.
 *
 * PURE: validation only. An omitted field is left alone; `url` and `token` may be sent
 * as "" to clear them (listen-only). Nothing here ever echoes the IRK.
 */
object Provision {
    data class Result(
        val room: String? = null,
        val url: String? = null,
        val token: String? = null,
        val irkHex: String? = null,
        val rssi: Int? = null,
        val errors: List<String> = emptyList(),
    ) {
        /** What changed, safe to log: never the IRK or token themselves. */
        fun summary(): String = listOfNotNull(
            room?.let { "room=$it" },
            url?.let { if (it.isEmpty()) "url cleared (listen only)" else "url=$it" },
            token?.let { if (it.isEmpty()) "token cleared" else "token set" },
            irkHex?.let { "irk set" },
            rssi?.let { "rssi=$it" },
        ).joinToString(", ").ifEmpty { "nothing" } +
            if (errors.isEmpty()) "" else " | refused: " + errors.joinToString("; ")
    }

    private val ROOM = Regex("^[a-z0-9-]{1,40}$")

    fun validate(room: String?, url: String?, token: String?, irk: String?, rssi: Int?): Result {
        val errors = mutableListOf<String>()

        val r = room?.trim()?.let { if (ROOM.matches(it)) it else { errors += "room must be a sensor room id"; null } }
        val u = url?.trim()?.let {
            if (it.isEmpty() || it.startsWith("http://") || it.startsWith("https://")) it
            else { errors += "url must be http(s) or empty"; null }
        }
        val t = token?.trim()
        val k = irk?.trim()?.replace(" ", "")?.lowercase()?.let {
            if (Rpa.fromHex(it) != null) it else { errors += "irk must be exactly 32 hex characters"; null }
        }
        val s = rssi?.let { if (it in -120..0) it else { errors += "rssi must be between -120 and 0"; null } }

        return Result(r, u, t, k, s, errors)
    }
}
