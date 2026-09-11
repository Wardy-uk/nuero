package uk.nickward.sara.sensor

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.LocationManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.util.Log
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The study's room sensor: scans, judges, and PUSHES a reading every 3 seconds to
 * `POST /api/presence/sensor` — the same contract sara-room-sensor.py uses, so the
 * backend needs no change and the study's own sensor decides the study's screen.
 *
 * Pushed, never pulled: an unreachable tablet must age into staleness at the other end
 * rather than look like an absent Watch.
 *
 * Android-specific traps, each handled here rather than discovered on the wall:
 *  - ⚠ Android 8.1+ delivers NOTHING to an unfiltered scan while the screen is off. So
 *    the scan is unfiltered with the screen on and narrowed to Apple adverts with it
 *    off, restarted on every change, and the reading says which (`scanScope`).
 *  - ⚠ Android 6-11 returns no scan results at all while system Location is OFF, and
 *    raises no error. Checked every tick and reported as a fault — otherwise "Location
 *    off" is indistinguishable from an empty room, which is the Pi's fifteen-day bug.
 *  - ⚠ Starting a scan more than 5 times in 30s is silently throttled to no results,
 *    so restarts are spaced. A scan left running for 30 minutes can be demoted to
 *    opportunistic, so it is refreshed every 25.
 *  - The CPU sleeps with the screen off even on a charger, which would stop the report
 *    loop exactly when SARA is showing the locked screen: a partial wake lock and a Wi-Fi
 *    lock are held while the service runs. This is a wall-powered tablet.
 */
class SensorService : Service() {

    private lateinit var settings: Settings
    private lateinit var presence: Presence
    private var rpa: Rpa? = null

    private val thread = HandlerThread("sara-sensor").apply { start() }
    private val handler = Handler(thread.looper)
    private val pushExecutor = Executors.newSingleThreadExecutor()
    private val pushing = AtomicBoolean(false)

    private var scanner: BluetoothLeScanner? = null
    private var scanning = false
    private var scope = Presence.SCOPE_ALL
    private var lastStartAt = 0L
    private var scanFault: String? = null
    private var consecutiveFailures = 0
    private var deafSince: Long? = null

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    // SARA's greeting on arrival (11 Sep 2026). NEURO chooses the words and whether to
    // speak; sara/backend hands them over in the reply to a reading; this only says
    // them. Android's own engine, because WebView speech output is unreliable.
    private var tts: TextToSpeech? = null
    @Volatile private var ttsReady = false
    @Volatile private var lastGreetingId: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        settings = Settings(this)
        running = true
        tts = TextToSpeech(this) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            if (ttsReady) tts?.language = Locale.UK
            else Log.w(TAG, "text-to-speech unavailable (status $status) - greetings will not be spoken")
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startInForeground()
        // (Re)read settings on every start, so "Save & start" applies edits.
        presence = Presence(room = settings.room, inRoomRssi = settings.inRoomRssi)
        rpa = Rpa.fromHex(settings.irkHex)
        acquireLocks()
        registerScreenReceiver()
        handler.removeCallbacksAndMessages(null)
        handler.post { restartScan("service start") }
        handler.postDelayed(tick, REPORT_MS)
        handler.postDelayed(refresh, REFRESH_MS)
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        handler.removeCallbacksAndMessages(null)
        handler.post { stopScan() }
        try { unregisterReceiver(screenReceiver) } catch (_: Exception) {}
        wakeLock?.let { if (it.isHeld) it.release() }
        wifiLock?.let { if (it.isHeld) it.release() }
        tts?.shutdown()
        thread.quitSafely()
        pushExecutor.shutdown()
        super.onDestroy()
    }

    // ── Scanning ────────────────────────────────────────────────────────────

    private val callback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) = record(result)
        override fun onBatchScanResults(results: MutableList<ScanResult>) = results.forEach { record(it) }
        override fun onScanFailed(errorCode: Int) {
            handler.post {
                scanning = false
                consecutiveFailures++
                presence.resets++
                scanFault = "scan start failed: code $errorCode (attempt $consecutiveFailures)"
                Log.w(TAG, scanFault!!)
                // Escalate like the Pi: retry first, cycle the adapter if that is not enough.
                if (consecutiveFailures >= HARD_RESET_AFTER) cycleAdapter()
                handler.postDelayed({ restartScan("after failure") }, RETRY_MS)
            }
        }
    }

    private fun record(result: ScanResult) {
        val address = result.device?.address ?: return
        val isWatch = rpa?.matches(address) == true
        presence.onAdvert(SystemClock.elapsedRealtime(), address, result.rssi, isWatch)
    }

    @SuppressLint("MissingPermission")
    private fun restartScan(reason: String) {
        val now = SystemClock.elapsedRealtime()
        val wait = MIN_START_GAP_MS - (now - lastStartAt)
        if (wait > 0) {
            handler.removeCallbacks(pendingRestart)
            handler.postDelayed(pendingRestart, wait)
            return
        }
        stopScan()

        val adapter = (getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
        if (adapter == null || !adapter.isEnabled) {
            scanFault = "Bluetooth is off"
            handler.postDelayed({ restartScan("waiting for Bluetooth") }, RETRY_MS)
            return
        }
        val le = adapter.bluetoothLeScanner ?: run {
            scanFault = "no Bluetooth LE scanner available"
            handler.postDelayed({ restartScan("waiting for scanner") }, RETRY_MS)
            return
        }

        scope = if (isScreenOn()) Presence.SCOPE_ALL else Presence.SCOPE_APPLE
        val filters: List<ScanFilter>? = if (scope == Presence.SCOPE_APPLE)
            listOf(ScanFilter.Builder().setManufacturerData(APPLE_COMPANY_ID, byteArrayOf()).build())
        else null
        val scanSettings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
            .setReportDelay(0)
            .build()

        try {
            le.startScan(filters, scanSettings, callback)
            scanner = le
            scanning = true
            lastStartAt = now
            scanFault = null
            deafSince = null
            presence.scanStarted(now)
            Log.i(TAG, "scanning ($scope) for room '${settings.room}' - $reason")
        } catch (e: Exception) {
            scanFault = "scan start failed: ${e.javaClass.simpleName}"
            presence.resets++
            handler.postDelayed({ restartScan("after exception") }, RETRY_MS)
        }
    }

    private val pendingRestart = Runnable { restartScan("deferred") }

    @SuppressLint("MissingPermission")
    private fun stopScan() {
        if (scanning) {
            try { scanner?.stopScan(callback) } catch (_: Exception) {}
        }
        scanning = false
    }

    @SuppressLint("MissingPermission")
    @Suppress("DEPRECATION")
    private fun cycleAdapter() {
        // Allowed below Android 13 with BLUETOOTH_ADMIN; this tablet is 8.1. Anywhere
        // it is refused, the retry loop carries on and the fault stays reported.
        try {
            val adapter = (getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter ?: return
            Log.w(TAG, "cycling the Bluetooth adapter")
            adapter.disable()
            handler.postDelayed({ try { adapter.enable() } catch (_: Exception) {} }, 3_000)
            consecutiveFailures = 0
        } catch (_: Exception) {}
    }

    // ── Reporting ───────────────────────────────────────────────────────────

    private val tick = object : Runnable {
        override fun run() {
            val now = SystemClock.elapsedRealtime()
            val fault = currentFault()
            val reading = presence.reading(now, scope, Instant.now().toString(), fault)
            lastReading = reading
            push(reading)
            watchdog(now, reading)
            handler.postDelayed(this, REPORT_MS)
        }
    }

    /** Things that make the sensor unable to hear, in the order they are worth fixing. */
    private fun currentFault(): String? {
        if (rpa == null) return "no valid IRK configured - cannot recognise the Watch"
        if (!isLocationOn()) return "Location is off - Android returns no Bluetooth scan results without it"
        // ⚠ Android 10-11 (the bedroom P30): with only FOREGROUND location, scan results
        // stop the moment another app (the kiosk) is in front — silently, no error. Named
        // as a fault so it reads as "cannot hear" rather than as an empty room.
        if (Build.VERSION.SDK_INT in Build.VERSION_CODES.Q..Build.VERSION_CODES.R &&
            checkSelfPermission(android.Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            return "background location not granted - Android 10+ withholds scan results behind other apps"
        }
        return scanFault
    }

    /** A healthy house is never silent: deaf for a whole health window restarts the scan. */
    private fun watchdog(now: Long, reading: Map<String, Any?>) {
        if (reading["healthy"] == true || scanFault != null || !scanning) {
            deafSince = null
            return
        }
        // With the screen off only Apple devices are audible, and silence there is
        // plausible (he is out with his phone). Restarting would not help.
        if (scope == Presence.SCOPE_APPLE) return
        val since = deafSince ?: now.also { deafSince = it }
        if (now - since > DEAF_RESTART_MS) {
            Log.w(TAG, "deaf - restarting scan")
            presence.resets++
            deafSince = null
            restartScan("deaf")
        }
    }

    private val refresh = object : Runnable {
        override fun run() {
            restartScan("periodic refresh")
            handler.postDelayed(this, REFRESH_MS)
        }
    }

    private fun push(reading: Map<String, Any?>) {
        val url = settings.pushUrl
        if (url.isEmpty()) {
            lastPush = "not pushing - no URL set"
            return
        }
        // One in flight at a time. A slow backend drops readings rather than queueing
        // them: a queued reading is stale by the time it lands, and staleness at the
        // other end is the honest signal.
        if (!pushing.compareAndSet(false, true)) return
        val body = Json.encode(reading)
        val token = settings.token
        pushExecutor.execute {
            try {
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.connectTimeout = 5_000
                conn.readTimeout = 5_000
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                if (token.isNotEmpty()) conn.setRequestProperty("X-Sara-Sensor-Token", token)
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                val code = conn.responseCode
                // A refusal says why; a sensor that cannot tell a 400 from a 200 reports
                // into a hole for a fortnight.
                val text = (if (code >= 400) conn.errorStream else conn.inputStream)
                    ?.bufferedReader()?.use { it.readText() }?.take(200) ?: ""
                lastPush = if (code < 400) "accepted ($code)" else "REJECTED $code: $text"
                conn.disconnect()
                if (code < 400) speakGreeting(text)
            } catch (e: Exception) {
                lastPush = "failed: ${e.javaClass.simpleName} ${e.message ?: ""}".trim()
            } finally {
                lastPushAt = System.currentTimeMillis()
                pushing.set(false)
            }
        }
    }

    /** Speak the greeting in a reading's reply, once per id. Never fails the push. */
    private fun speakGreeting(replyBody: String) {
        val greeting = Greeting.parse(replyBody) ?: return
        if (greeting.id == lastGreetingId) return
        lastGreetingId = greeting.id
        lastGreeting = greeting.text
        if (!ttsReady) {
            Log.w(TAG, "greeting received but text-to-speech is not ready")
            return
        }
        tts?.speak(greeting.text, TextToSpeech.QUEUE_FLUSH, null, greeting.id)
    }

    // ── Device state ────────────────────────────────────────────────────────

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            handler.post { restartScan(intent.action ?: "screen change") }
        }
    }

    private var receiverRegistered = false

    private fun registerScreenReceiver() {
        if (receiverRegistered) return
        registerReceiver(screenReceiver, IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
        })
        receiverRegistered = true
    }

    private fun isScreenOn(): Boolean = (getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive

    private fun isLocationOn(): Boolean {
        // Android 12+ with BLUETOOTH_SCAN (neverForLocation) does not need Location.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return true
        val lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) lm.isLocationEnabled
        else lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
    }

    @SuppressLint("WakelockTimeout")
    @Suppress("DEPRECATION")
    private fun acquireLocks() {
        if (wakeLock?.isHeld != true) {
            wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sara:sensor").apply { acquire() }
        }
        if (wifiLock?.isHeld != true) {
            wifiLock = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
                .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "sara:sensor").apply { acquire() }
        }
    }

    private fun startInForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Room sensor", NotificationManager.IMPORTANCE_LOW)
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )
        val notification = Notification.Builder(this, CHANNEL)
            .setContentTitle("SARA room sensor")
            .setContentText("Listening for the Watch in the ${settings.room}")
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    companion object {
        private const val TAG = "SaraSensor"
        private const val CHANNEL = "sensor"
        private const val NOTIFICATION_ID = 1
        const val APPLE_COMPANY_ID = 0x004C
        const val REPORT_MS = 3_000L
        const val RETRY_MS = 10_000L
        const val MIN_START_GAP_MS = 7_000L
        const val REFRESH_MS = 25 * 60_000L
        const val DEAF_RESTART_MS = 45_000L
        const val HARD_RESET_AFTER = 3

        /** Read by the setup screen. Never contains the IRK. */
        @Volatile var lastReading: Map<String, Any?>? = null
        @Volatile var lastPush: String? = null
        @Volatile var lastPushAt: Long = 0
        @Volatile var running: Boolean = false
        @Volatile var lastGreeting: String? = null

        fun start(context: Context) {
            context.startForegroundService(Intent(context, SensorService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, SensorService::class.java))
        }
    }
}
