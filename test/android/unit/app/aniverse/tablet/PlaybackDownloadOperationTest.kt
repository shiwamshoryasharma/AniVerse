package app.aniverse.tablet
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class PlaybackDownloadOperationTest {
 @Test fun timeoutBeforeWorkerPreventsLateQueuePublication(){
  val op=PlaybackDownloadOperation();val writes=AtomicInteger()
  assertTrue(op.cancel());assertFalse(op.cancel())
  assertNull(op.publish{writes.incrementAndGet()});assertEquals(0,writes.get())
 }
 @Test fun successfulPublicationCannotBecomeAFailedTimeout(){
  val op=PlaybackDownloadOperation()
  assertEquals("queued-id",op.publish{"queued-id"});assertFalse(op.cancel())
 }
 @Test fun cancellationRacingWithCommitHasExactlyOneOutcome(){
  val op=PlaybackDownloadOperation();val entered=CountDownLatch(1);val release=CountDownLatch(1)
  val writes=AtomicInteger();val cancelled=AtomicBoolean(true)
  val worker=Thread{op.publish{entered.countDown();check(release.await(2,TimeUnit.SECONDS));writes.incrementAndGet()}}
  worker.start();assertTrue(entered.await(2,TimeUnit.SECONDS))
  val timeout=Thread{cancelled.set(op.cancel())};timeout.start()
  release.countDown();worker.join(2000);timeout.join(2000)
  assertFalse(worker.isAlive);assertFalse(timeout.isAlive);assertEquals(1,writes.get());assertFalse(cancelled.get())
 }
 @Test fun failedDatabaseWriteLeavesNoAcceptedQueue(){
  val op=PlaybackDownloadOperation()
  try{op.publish<String>{error("fixture write failure")};fail("failure expected")}catch(_:IllegalStateException){}
  assertTrue(op.cancel());assertNull(op.publish{"late-item"})
 }
}
