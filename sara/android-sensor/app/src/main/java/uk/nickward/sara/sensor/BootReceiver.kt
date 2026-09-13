package uk.nickward.sara.sensor

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * A wall sensor that needs a tap after a power cut is one that is off most of the time.
 *
 * ⚠ SEVERAL WAYS IN, NOT ONE. Boot was the only trigger until the work Fire came back
 * from a flat battery with the kiosk running and the sensor dead (13 Sep 2026) — a
 * sideloaded app cannot count on a Fire delivering one broadcast at one moment. Power
 * connected matters for a wall device that just had its charger plugged back in, and
 * the app being replaced covers every reinstall. [KeepAlive] is the backstop that needs
 * no broadcast at all.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val known = intent.action == Intent.ACTION_BOOT_COMPLETED ||
            intent.action == Intent.ACTION_POWER_CONNECTED ||
            intent.action == Intent.ACTION_MY_PACKAGE_REPLACED
        if (!known) return
        if (!Settings(context).enabled) return
        Log.i("SaraSensor", "starting after ${intent.action}")
        // Re-scheduled here too: a persisted job should survive a reboot, and this costs
        // nothing if it did.
        KeepAlive.schedule(context)
        if (!SensorService.running) SensorService.start(context)
    }
}
