package uk.nickward.sara.sensor

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings as AndroidSettings
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * Setup and live status. The status block is the proof the sensor works: a healthy
 * reading shows background devices, and walking in and out of the study should move
 * `adverts`, `rssiMedian` and `inRoom`. Nothing here ever displays the IRK.
 */
class MainActivity : Activity() {

    private lateinit var settings: Settings
    private lateinit var room: EditText
    private lateinit var url: EditText
    private lateinit var token: EditText
    private lateinit var irk: EditText
    private lateinit var rssi: EditText
    private lateinit var status: TextView
    private val ui = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = Settings(this)

        val pad = dp(16)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }

        col.addView(heading("SARA room sensor"))
        col.addView(note("Listens for Nick's Watch and reports this room to SARA. Keep it plugged in."))

        room = field(col, "Room", settings.room, InputType.TYPE_CLASS_TEXT)
        url = field(col, "Push URL (http://<pi5>:3005/api/presence/sensor)", settings.pushUrl,
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        token = field(col, "Sensor token (blank if the backend has none)", settings.token,
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        irk = field(col, if (settings.irkHex.isEmpty()) "Watch IRK (32 hex characters)" else "Watch IRK - set (leave blank to keep)", "",
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        rssi = field(col, "In-room RSSI threshold (dBm)", settings.inRoomRssi.toString(),
            InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_SIGNED)

        col.addView(button("Save & start") { saveAndStart() })
        col.addView(button("Stop") {
            settings.enabled = false
            SensorService.stop(this)
        })
        col.addView(button("Don't battery-optimise this app") {
            startActivity(Intent(AndroidSettings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        })
        col.addView(button("Location settings") {
            startActivity(Intent(AndroidSettings.ACTION_LOCATION_SOURCE_SETTINGS))
        })

        status = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 13f
            setPadding(0, dp(16), 0, 0)
        }
        col.addView(status)

        setContentView(ScrollView(this).apply { addView(col) })
    }

    override fun onResume() {
        super.onResume()
        ui.post(refresh)
    }

    override fun onPause() {
        ui.removeCallbacks(refresh)
        super.onPause()
    }

    private val refresh = object : Runnable {
        override fun run() {
            status.text = describe()
            ui.postDelayed(this, 2_000)
        }
    }

    private fun describe(): String {
        val b = StringBuilder()
        b.append(if (SensorService.running) "Service: running\n" else "Service: STOPPED\n")
        b.append("IRK: ").append(if (Rpa.fromHex(settings.irkHex) != null) "set" else "NOT SET").append('\n')
        val push = SensorService.lastPush
        if (push != null) {
            val age = (System.currentTimeMillis() - SensorService.lastPushAt) / 1000
            b.append("Last push: ").append(push).append(" (${age}s ago)\n")
        }
        SensorService.lastGreeting?.let { b.append("Last greeting: ").append(it).append('\n') }
        val r = SensorService.lastReading
        if (r == null) {
            b.append("\nNo reading yet.")
        } else {
            b.append('\n')
            for (key in listOf("room", "status", "inRoom", "why", "healthy", "adverts", "rate",
                "rssiMedian", "rssiMax", "lastSeenS", "backgroundDevices", "scanScope", "resets")) {
                b.append(key.padEnd(18)).append(r[key]).append('\n')
            }
        }
        return b.toString()
    }

    private fun saveAndStart() {
        val newIrk = irk.text.toString().trim().replace(" ", "")
        if (newIrk.isNotEmpty()) {
            if (Rpa.fromHex(newIrk) == null) {
                irk.error = "Must be exactly 32 hex characters"
                return
            }
            settings.irkHex = newIrk
            irk.setText("")
            irk.hint = "Watch IRK - set (leave blank to keep)"
        }
        val threshold = rssi.text.toString().toIntOrNull()
        if (threshold == null || threshold > 0 || threshold < -120) {
            rssi.error = "A negative dBm figure, e.g. -80"
            return
        }
        if (room.text.isBlank()) {
            room.error = "A sensor with no room cannot be placed"
            return
        }
        settings.room = room.text.toString()
        settings.pushUrl = url.text.toString()
        settings.token = token.text.toString()
        settings.inRoomRssi = threshold
        settings.enabled = true

        val missing = neededPermissions().filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) {
            requestPermissions(missing.toTypedArray(), REQUEST_PERMISSIONS)
        } else {
            SensorService.start(this)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        if (requestCode != REQUEST_PERMISSIONS) return
        // Start regardless: a refused permission surfaces as a named fault in the
        // reading, which is more useful on the wall than a service that never started.
        SensorService.start(this)
    }

    private fun neededPermissions(): List<String> = buildList {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) add(Manifest.permission.BLUETOOTH_SCAN)
        else add(Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
    }

    // ── tiny view helpers ───────────────────────────────────────────────────

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun heading(text: String) = TextView(this).apply {
        this.text = text
        textSize = 22f
        setTypeface(typeface, Typeface.BOLD)
    }

    private fun note(text: String) = TextView(this).apply {
        this.text = text
        setPadding(0, dp(4), 0, dp(12))
    }

    private fun field(parent: LinearLayout, label: String, value: String, type: Int): EditText {
        parent.addView(TextView(this).apply { text = label; setPadding(0, dp(8), 0, 0) })
        return EditText(this).apply {
            setSingleLine(true)
            inputType = type
            setText(value)
            hint = label
        }.also { parent.addView(it) }
    }

    private fun button(text: String, onClick: (View) -> Unit) = Button(this).apply {
        this.text = text
        setOnClickListener { onClick(it) }
    }

    companion object {
        private const val REQUEST_PERMISSIONS = 1
    }
}
