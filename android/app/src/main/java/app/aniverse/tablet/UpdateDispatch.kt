package app.aniverse.tablet

import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit

/** A timed-out queued UI action must not run later and open an installer unexpectedly. */
internal object UpdateDispatch {
    fun await(task:FutureTask<Unit>,timeoutMillis:Long=5000) {
        try { task.get(timeoutMillis,TimeUnit.MILLISECONDS) }
        catch(error:Exception) {
            task.cancel(false)
            if(error is InterruptedException)Thread.currentThread().interrupt()
            throw error
        }
    }
}
