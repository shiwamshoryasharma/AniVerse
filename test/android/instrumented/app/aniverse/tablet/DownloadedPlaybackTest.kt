package app.aniverse.tablet

import android.content.Intent
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicReference

/** Invoked by android-playing-download.mjs with the opaque ID returned by the real Watch action. */
@RunWith(AndroidJUnit4::class)
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class DownloadedPlaybackTest {
 @Test fun queuedPlayingMediaRendersFromLocalStorage(){
  val args=InstrumentationRegistry.getArguments();val id=args.getString("downloadId")
  assumeTrue("Run through the playing-download runtime fixture",!id.isNullOrBlank())
  val instrumentation=InstrumentationRegistry.getInstrumentation()
  val context=instrumentation.targetContext
  val store=(context.applicationContext as TabletApplication).offline
  assertEquals("complete",store.download(id!!).status)
  assertNull("Completed item retained source cookies",store.download(id).request)
  args.getString("expectedSha256")?.let { expected->
   val actual=MessageDigest.getInstance("SHA-256").digest(store.video(id).readBytes()).joinToString(""){"%02x".format(it.toInt() and 255)}
   assertEquals("Downloaded video bytes changed",expected,actual)
  }
  fun <T> main(block:()->T):T{val value=AtomicReference<T>();instrumentation.runOnMainSync{value.set(block())};return value.get()}
  val activity=instrumentation.startActivitySync(Intent(context,OfflinePlayerActivity::class.java)
   .putExtra("id",id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as OfflinePlayerActivity
  try{
   val deadline=SystemClock.uptimeMillis()+15000;var decoded=false
   while(SystemClock.uptimeMillis()<deadline){
    decoded=main{
     val player=activity.player ?: return@main false
     player.videoDecoderCounters?.ensureUpdated()
     player.currentPosition>1500&&player.videoSize.width>0&&(player.videoDecoderCounters?.renderedOutputBufferCount ?: 0)>3
    }
    if(decoded)break
    SystemClock.sleep(100)
   }
   assertTrue("The downloaded episode did not render advancing local video",decoded)
  }finally{main{activity.finish()};instrumentation.waitForIdleSync()}
 }
}
