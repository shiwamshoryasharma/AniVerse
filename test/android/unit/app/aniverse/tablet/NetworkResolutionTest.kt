package app.aniverse.tablet

import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.*
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.Test

class NetworkResolutionTest {
    private val publicAddress=InetAddress.getByAddress(byteArrayOf(1,1,1,1))
    private val privateAddress=InetAddress.getByAddress(byteArrayOf(127,0,0,1))
    private val url="https://source.example.test/player"
    private open class ImmediateExecutor:AbstractExecutorService() {
        private var stopped=false
        override fun execute(command:Runnable){command.run()}
        override fun shutdown(){stopped=true}
        override fun shutdownNow():MutableList<Runnable>{stopped=true;return mutableListOf()}
        override fun isShutdown()=stopped
        override fun isTerminated()=stopped
        override fun awaitTermination(timeout:Long,unit:TimeUnit)=stopped
    }
    @Test fun executorRejectionDoesNotPoisonTheHostCache() {
        var first=true
        val executor=object:ImmediateExecutor(){
            override fun execute(command:Runnable){if(first){first=false;throw RejectedExecutionException("Busy fixture")}else command.run()}
        }
        val policy=NetworkPolicy(resolve={arrayOf(publicAddress)},dns=executor)
        try {assertFalse(policy.allow(url));assertTrue("Retry must resolve after transient admission failure",policy.allow(url))}
        finally {policy.close()}
    }
    @Test fun queuedTimeoutDoesNotPoisonCacheOrRunAnAbandonedLookup() {
        var first=true
        var abandoned:Runnable?=null
        var calls=0
        val executor=object:ImmediateExecutor(){
            override fun execute(command:Runnable){if(first){first=false;abandoned=command}else command.run()}
        }
        val policy=NetworkPolicy(resolve={calls++;arrayOf(publicAddress)},dns=executor,dnsTimeoutMillis=1)
        try {
            assertFalse(policy.allow(url))
            assertTrue("Retry must resolve after a transient timeout",policy.allow(url))
            abandoned!!.run()
            assertEquals("The cancelled queued lookup must not execute",1,calls)
        } finally {policy.close()}
    }
    @Test fun resolverFailureIsRetriedWithoutTrustingAnUnresolvedHost() {
        var calls=0
        val policy=NetworkPolicy(resolve={if(++calls==1)throw UnknownHostException("Transient fixture");arrayOf(publicAddress)},dns=ImmediateExecutor())
        try {assertFalse(policy.allow(url));assertTrue(policy.allow(url));assertEquals(2,calls)}
        finally {policy.close()}
    }
    @Test fun concurrentRequestsForOneHostShareOneLookup() {
        val callers=8
        val waiting=CountDownLatch(callers)
        val submissions=AtomicInteger()
        val tasks=ConcurrentLinkedQueue<Runnable>()
        val executor=object:ImmediateExecutor(){
            override fun <T> newTaskFor(callable:Callable<T>):RunnableFuture<T> = object:FutureTask<T>(callable){
                override fun get(timeout:Long,unit:TimeUnit):T {waiting.countDown();return super.get(timeout,unit)}
            }
            override fun execute(command:Runnable){submissions.incrementAndGet();tasks.add(command)}
        }
        val policy=NetworkPolicy(resolve={arrayOf(publicAddress)},dns=executor,dnsTimeoutMillis=5000)
        val threads=Executors.newFixedThreadPool(callers)
        try {
            val results=(1..callers).map{threads.submit<Boolean>{policy.allow(url)}}
            assertTrue("All callers reached the same unresolved-host decision",waiting.await(2,TimeUnit.SECONDS))
            val submitted=submissions.get()
            while(true){val task=tasks.poll() ?: break;task.run()}
            assertTrue(results.all{it.get(2,TimeUnit.SECONDS)})
            assertEquals("Only one resolver task may be submitted per cold host",1,submitted)
        } finally {
            while(true){val task=tasks.poll() ?: break;task.run()}
            threads.shutdownNow();policy.close()
        }
    }
    @Test fun completedPrivateAddressDenialRemainsCached() {
        var calls=0
        val policy=NetworkPolicy(resolve={calls++;arrayOf(privateAddress)},dns=ImmediateExecutor())
        try {assertFalse(policy.allow(url));assertFalse(policy.allow(url));assertEquals(1,calls)}
        finally {policy.close()}
    }
}
