package uk.nickward.sara.sensor

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** Applies an ADB provisioning broadcast. See [Provision] for why and how. */
class ProvisionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val r = Provision.validate(
            room = intent.getStringExtra("room"),
            url = intent.getStringExtra("url"),
            token = intent.getStringExtra("token"),
            irk = intent.getStringExtra("irk"),
            rssi = if (intent.hasExtra("rssi")) intent.getIntExtra("rssi", 0) else null,
        )
        val settings = Settings(context)
        r.room?.let { settings.room = it }
        r.url?.let { settings.pushUrl = it }
        r.token?.let { settings.token = it }
        r.irkHex?.let { settings.irkHex = it }
        r.rssi?.let { settings.inRoomRssi = it }

        val start = intent.getBooleanExtra("start", false) && r.errors.isEmpty()
        if (start) {
            settings.enabled = true
            // Restarting re-reads settings, so an edit applies to a running sensor too.
            SensorService.start(context)
        }
        val line = "provisioned: ${r.summary()}${if (start) " | started" else ""}"
        Log.i("SaraSensor", line)
        resultData = line
    }

    companion object {
        const val ACTION = "uk.nickward.sara.sensor.PROVISION"
    }
}
