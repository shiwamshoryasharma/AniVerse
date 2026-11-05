package app.aniverse.tablet

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class TransferLivenessTest {
    @Test fun repeatedReadsPollStatusAtMostOncePer250Milliseconds(){
        var now=0L;var reads=0
        val live=TransferLiveness({reads++;true},{now})
        repeat(2000){assertTrue(live.isActive())}
        assertEquals(1,reads)
        now=249;assertTrue(live.isActive());assertEquals(1,reads)
        now=250;assertTrue(live.isActive());assertEquals(2,reads)
    }
    @Test fun pausedCancelledOrCompletedRecordsStopWithinThePollingBoundAndCannotRevive(){
        for(terminal in listOf("paused","cancelled","complete")){
            var now=0L;var status="running"
            val live=TransferLiveness({status=="running"},{now})
            assertTrue(live.isActive());status=terminal
            now=250;assertFalse(live.isActive())
            status="running";now=500;assertFalse(live.isActive())
        }
    }
    @Test fun cancellationInvalidatesCachedRunningStatusImmediately(){
        var reads=0
        val live=TransferLiveness({reads++;true},{0})
        assertTrue(live.isActive())
        val cancel=Thread{live.cancel()};cancel.start();cancel.join(2000)
        assertFalse(cancel.isAlive);assertFalse(live.isActive());assertEquals(1,reads)
    }
    @Test fun cancellationDuringABlockedPollCannotReturnStaleRunningStatus(){
        val entered=CountDownLatch(1);val release=CountDownLatch(1)
        val live=TransferLiveness({entered.countDown();check(release.await(2,TimeUnit.SECONDS));true},{0})
        var accepted=true
        val worker=Thread{accepted=live.isActive()};worker.start()
        assertTrue(entered.await(2,TimeUnit.SECONDS));live.cancel();release.countDown();worker.join(2000)
        assertFalse(worker.isAlive);assertFalse(accepted)
    }
    @Test fun failedPollAndInterruptedThreadCannotAuthorizeFurtherReads(){
        var fail=true
        val failed=TransferLiveness({if(fail)error("database unavailable") else true},{0})
        assertFalse(failed.isActive());fail=false;assertFalse(failed.isActive())
        val live=TransferLiveness({true},{0})
        try{Thread.currentThread().interrupt();assertFalse(live.isActive())}
        finally{Thread.interrupted()}
    }
    @Test fun storageChecksRunOnFirstReadThenAt250MillisecondsOrOneMebibyte(){
        var now=0L;var checks=0
        val storage=TransferStorageChecks({checks++;128L*1024*1024},{now})
        storage.onRead(8192);assertEquals(1,checks)
        repeat(100){storage.onRead(8192)};assertEquals(1,checks)
        now=250;storage.onRead(1);assertEquals(2,checks)
        storage.onRead(1024*1024);assertEquals(3,checks)
    }
    @Test fun storageReserveStillStopsAHighThroughputReadBeforeAnotherMebibyte(){
        var free=128L*1024*1024
        val storage=TransferStorageChecks({free},{0})
        storage.onRead(1);free=64L*1024*1024
        try{storage.onRead(1024*1024);fail("Low storage was accepted")}
        catch(_:IllegalArgumentException){}
    }
}
