package app.aniverse.tablet

import java.util.concurrent.atomic.AtomicBoolean

/** Per-worker liveness: cheap per-read cancellation, bounded status-only database polling. */
internal class TransferLiveness(
    private val isRunning:()->Boolean,
    private val clockMillis:()->Long={System.nanoTime()/1_000_000}
) {
    private val cancelled=AtomicBoolean(false)
    private var polled=false
    private var lastPoll=0L
    private fun stopped()=cancelled.get()||Thread.currentThread().isInterrupted
    fun cancel(){cancelled.set(true)}
    @Synchronized fun isActive():Boolean {
        if(stopped())return false
        val now=clockMillis()
        if(!polled||now-lastPoll>=250||now<lastPoll){
            lastPoll=now;polled=true
            // Failure/terminal status belongs to this worker permanently, even if retried later.
            if(!runCatching(isRunning).getOrDefault(false))cancelled.set(true)
        }
        // cancel() must not wait for a blocked database poll or authorize its late result.
        return !stopped()
    }
}

/** Keep the reserve check bounded by both elapsed time and newly consumed bytes. */
internal class TransferStorageChecks(
    private val availableBytes:()->Long,
    private val clockMillis:()->Long={System.nanoTime()/1_000_000}
) {
    private var checked=false
    private var lastCheck=0L
    private var consumed=0L
    @Synchronized fun onRead(count:Int){
        require(count>=0);consumed+=count
        val now=clockMillis()
        if(!checked||now-lastCheck>=250||now<lastCheck||consumed>=1024*1024){
            require(availableBytes()>64L*1024*1024){"Low storage: pause this source download."}
            checked=true;lastCheck=now;consumed=0
        }
    }
}
