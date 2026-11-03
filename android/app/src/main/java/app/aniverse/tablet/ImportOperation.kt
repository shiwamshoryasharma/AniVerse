package app.aniverse.tablet

import android.content.ContentResolver
import android.net.Uri
import android.os.CancellationSignal
import android.os.SystemClock
import android.system.Os
import android.system.OsConstants
import android.system.StructPollfd
import java.io.Closeable
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** A selected provider never owns ordinary bridge workers, admission slots or late publication. */
class ImportOperation(private val idleMs:Long=30_000,private val maxMs:Long=60*60_000,
                      onCancel:(Exception)->Unit={}) {
    val signal=CancellationSignal()
    private val monitor=Any()
    private val started=SystemClock.elapsedRealtime()
    private var lastProgress=started
    private var state=0 // active, committed, cancelled
    private val cancellation=AtomicReference<((Exception)->Unit)?>(onCancel)
    private val resource=AtomicReference<Closeable?>()
    private val timer=ImportJobs.clock.scheduleWithFixedDelay({if(expired())cancel(IllegalStateException("File provider stopped responding. Choose a local file or try again."))},idleMs.coerceAtMost(500),idleMs.coerceAtMost(500),TimeUnit.MILLISECONDS)
    private fun expired()=synchronized(monitor){val now=SystemClock.elapsedRealtime();state==0&&(now-started>=maxMs||now-lastProgress>=idleMs)}
    val isActive:Boolean get()=synchronized(monitor){state==0}
    fun check(){if(expired())cancel(IllegalStateException("File provider stopped responding. Choose a local file or try again."));synchronized(monitor){check(state!=2){"Import cancelled."}}}
    fun progress(){check();synchronized(monitor){lastProgress=SystemClock.elapsedRealtime()}}
    fun <T> commit(block:()->T):T = synchronized(monitor){check();check(state==0){"Import is no longer active."};val value=block();state=1;timer.cancel(false);cancellation.set(null);value}
    fun cancel(error:Exception=IllegalStateException("Import cancelled.")) {
        val action=synchronized(monitor){if(state!=0)return;state=2;timer.cancel(false);cancellation.getAndSet(null)}
        // Reply first. A hostile provider may ignore or block its cancellation callback.
        action?.invoke(error)
        val item=resource.getAndSet(null)
        ImportJobs.cancelProvider{runCatching{item?.close()};signal.cancel()}
    }
    fun copy(resolver:ContentResolver,uri:Uri,output:OutputStream,maxBytes:Long,beforeWrite:()->Unit={}) :Long {
        check();val asset=resolver.openAssetFileDescriptor(uri,"r",signal) ?: error("Could not open the selected file.")
        try {
            resource.set(asset);check()
            val fd=asset.parcelFileDescriptor.fileDescriptor
            try{Os.lseek(fd,asset.startOffset,OsConstants.SEEK_SET)}catch(error:android.system.ErrnoException){if(error.errno!=OsConstants.ESPIPE||asset.startOffset!=0L)throw error}
            val flags=Os.fcntlInt(fd,OsConstants.F_GETFL,0);Os.fcntlInt(fd,OsConstants.F_SETFL,flags or OsConstants.O_NONBLOCK)
            var remaining=asset.declaredLength;var count=0L;val buffer=ByteArray(64*1024)
            val poll=StructPollfd().apply{this.fd=fd;events=OsConstants.POLLIN.toShort()}
            while(remaining!=0L){
                check();if(Os.poll(arrayOf(poll),250)==0)continue
                val amount=if(remaining<0)buffer.size else minOf(buffer.size.toLong(),remaining).toInt()
                val read=try{Os.read(fd,buffer,0,amount)}catch(error:android.system.ErrnoException){if(error.errno==OsConstants.EAGAIN||error.errno==OsConstants.EINTR)continue else throw error}
                if(read<=0)break
                progress();require(count+read<=maxBytes){"Selected file exceeds its size budget."};beforeWrite();output.write(buffer,0,read);count+=read;if(remaining>0)remaining-=read
            }
            check();require(remaining<=0){"The selected file ended early."};return count
        } finally {resource.compareAndSet(asset,null);runCatching{asset.close()}}
    }
}

/** Process-wide capacity stays bounded even when a provider ignores query/open cancellation. */
object ImportJobs {
    internal val clock=Executors.newSingleThreadScheduledExecutor{task->Thread(task,"import-deadlines").apply{isDaemon=true}}
    private val workers=ThreadPoolExecutor(2,2,30,TimeUnit.SECONDS,SynchronousQueue(),{task->Thread(task,"file-provider-import").apply{isDaemon=true}},ThreadPoolExecutor.AbortPolicy())
    private val cancellationWorker=ThreadPoolExecutor(2,2,30,TimeUnit.SECONDS,SynchronousQueue(),{task->Thread(task,"file-provider-cancel").apply{isDaemon=true}},ThreadPoolExecutor.DiscardPolicy())
    private val active=ConcurrentHashMap.newKeySet<ImportOperation>()
    internal fun cancelProvider(action:()->Unit){cancellationWorker.execute(action)}
    fun start(reply:(Any?,Exception?)->Unit,idleMs:Long=30_000,maxMs:Long=60*60_000,work:(ImportOperation)->Any?):ImportOperation {
        val callback=AtomicReference<((Any?,Exception?)->Unit)?>(reply)
        fun finish(value:Any?,error:Exception?){callback.getAndSet(null)?.invoke(value,error)}
        val operation=ImportOperation(idleMs,maxMs){finish(null,it)};active.add(operation)
        try{workers.execute{try{val result=work(operation);finish(result,null)}catch(error:Exception){operation.cancel(error);finish(null,error)}finally{active.remove(operation)}}}
        catch(error:Exception){active.remove(operation);operation.cancel(IllegalStateException("Another file provider is still busy. Try a local file after it finishes.",error))}
        return operation
    }
}
