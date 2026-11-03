package app.aniverse.tablet
import android.net.Uri
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.aniverse.tablet.fixture.FixtureProvider
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
@RunWith(AndroidJUnit4::class)
class ImportSafetyTest {
 private val instrumentation=InstrumentationRegistry.getInstrumentation()
 private val context=instrumentation.targetContext
 private val store get()=(context.applicationContext as TabletApplication).offline
 private fun uri(name:String)=Uri.parse("content://${context.packageName}.fixtures/$name")
 private fun prepare(){val folder=File(context.cacheDir,"offline-fixtures").apply{mkdirs()};instrumentation.context.assets.open("clip.mp4").use{input->File(folder,"clip.mp4").outputStream().use{input.copyTo(it)}};File(folder,"sub.srt").writeText("1\n00:00:00,000 --> 00:00:30,000\nKeep these captions\n")}
 private fun ids():Set<String> {val rows=store.list().getJSONArray("items");return (0 until rows.length()).map{rows.getJSONObject(it).getString("id")}.toSet()}
 @Test fun stalledVideoAndSubtitleImportsTimeoutOnceWithoutBlockingControls(){
  prepare();val video=store.importVideo(uri("clip.mp4")).getString("id");store.importSubtitle(video,uri("sub.srt"));val old=store.subtitle(video)!!.readText();val baseline=ids();val callbacks=AtomicInteger();val done=CountDownLatch(2);val failures=AtomicInteger()
  try{
   ImportJobs.start({_,error->callbacks.incrementAndGet();if(error!=null)failures.incrementAndGet();done.countDown()},250,5000){op->store.importVideo(uri("stall.mp4"),op)}
   ImportJobs.start({_,error->callbacks.incrementAndGet();if(error!=null)failures.incrementAndGet();done.countDown()},250,5000){op->store.importSubtitle(video,uri("prefix.mp4"),op)}
   val started=SystemClock.elapsedRealtime();repeat(10){store.list();(context.applicationContext as TabletApplication).store.load();store.downloads()};assertTrue(SystemClock.elapsedRealtime()-started<1000)
   assertTrue("Native timeout never completed",done.await(3,TimeUnit.SECONDS));FixtureProvider.release();SystemClock.sleep(400)
   assertEquals(2,callbacks.get());assertEquals(2,failures.get());assertEquals(baseline,ids());assertEquals(old,store.subtitle(video)!!.readText())
  }finally{FixtureProvider.release();store.remove(video)}
 }
 @Test fun lateProviderCannotPublishAfterDeadlineAndCapacityRecovers(){
  prepare();FixtureProvider.late=CountDownLatch(1);val before=ids();val done=CountDownLatch(1);val calls=AtomicInteger();val error=AtomicReference<Exception?>()
  ImportJobs.start({_,failure->calls.incrementAndGet();error.set(failure);done.countDown()},250,5000){op->store.importVideo(uri("late.mp4"),op)}
  try{assertTrue(done.await(3,TimeUnit.SECONDS));assertNotNull(error.get());assertEquals(before,ids())}finally{FixtureProvider.release()}
  SystemClock.sleep(500);assertEquals(1,calls.get());assertEquals(before,ids())
  val valid=store.importVideo(uri("slice.mp4")).getString("id");try{assertEquals(File(context.cacheDir,"offline-fixtures/clip.mp4").length(),store.video(valid).length())}finally{store.remove(valid)}
 }
 @Test fun cancellationBeforeCommitRetainsPreviousSubtitle(){
  prepare();val video=store.importVideo(uri("clip.mp4")).getString("id");store.importSubtitle(video,uri("sub.srt"));val before=store.subtitle(video)!!.readText();val operation=ImportOperation();operation.cancel()
  try{try{store.importSubtitle(video,uri("sub.srt"),operation);fail("Cancelled import accepted")}catch(expected:IllegalStateException){};assertEquals(before,store.subtitle(video)!!.readText())}finally{store.remove(video)}
 }
}
