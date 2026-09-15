package uk.nickward.saim.sensor

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.util.Log

/**
 * Makes the sensor come back on its own.
 *
 * ⚠ WHY (13 Sep 2026, the work Fire): the tablet ran itself flat overnight, and after
 * it powered back up the kiosk browser returned and THE SENSOR DID NOT. Boot start was
 * enabled, so either Fire OS never delivered the boot broadcast to a sideloaded app or
 * something killed the service shortly after. Either way a sensor whose only way back
 * is one broadcast at one moment is a sensor that is off until somebody notices — and
 * a room with no sensor has no screen verdict and no greeting.
 *
 * So the boot receiver is no longer the only route in. A PERSISTED periodic job asks,
 * every quarter of an hour, whether the sensor should be running — and starts it if it
 * is not. Persisted means it survives a reboot on its own, which is precisely the case
 * the boot broadcast was supposed to cover.
 *
 * ⚠ It only ever starts what Nick already switched on: `Settings.enabled` is his
 * decision, and a device he stopped deliberately must stay stopped. Starting an already
 * running service is harmless — `onStartCommand` re-reads the settings and carries on.
 */
object KeepAlive {
    const val JOB_ID = 4242
    const val PERIOD_MS = 15 * 60 * 1000L

    /** Idempotent: scheduling over an existing job replaces it, so callers need not check. */
    fun schedule(context: Context) {
        val scheduler = context.getSystemService(JobScheduler::class.java) ?: return
        val job = JobInfo.Builder(JOB_ID, ComponentName(context, KeepAliveJob::class.java))
            .setPersisted(true)                 // survives a reboot — the whole point
            .setPeriodic(PERIOD_MS)
            .setRequiresDeviceIdle(false)
            .setRequiresCharging(false)
            .build()
        val result = scheduler.schedule(job)
        Log.i("SaimSensor", "keep-alive job ${if (result == JobScheduler.RESULT_SUCCESS) "scheduled" else "REFUSED"}")
    }

    fun cancel(context: Context) {
        context.getSystemService(JobScheduler::class.java)?.cancel(JOB_ID)
    }
}

class KeepAliveJob : JobService() {
    override fun onStartJob(params: JobParameters?): Boolean {
        if (Settings(this).enabled && !SensorService.running) {
            Log.w("SaimSensor", "keep-alive: the sensor was not running — starting it")
            SensorService.start(this)
        }
        jobFinished(params, false)
        return false
    }

    override fun onStopJob(params: JobParameters?): Boolean = true   // reschedule
}
