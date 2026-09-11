package uk.nickward.sara.sensor

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** A wall sensor that needs a tap after a power cut is one that is off most of the time. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (Settings(context).enabled) SensorService.start(context)
    }
}
