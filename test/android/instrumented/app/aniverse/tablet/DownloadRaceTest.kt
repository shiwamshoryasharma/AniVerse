package app.aniverse.tablet
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
@RunWith(AndroidJUnit4::class)
class DownloadRaceTest {
 private val store get()=(InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as TabletApplication).offline
 @Test fun delayedWorkerUpdatesCannotUndoPauseOrCancellation(){
  val id=store.addDownload("https://download-fixture.test/episode.mp4","Race fixture")
  try{store.updateDownload(id,"running");store.updateDownload(id,"paused");store.updateDownload(id,"running",bytes=10);assertEquals("A delayed worker report overwrote Pause","paused",store.download(id).status)
   store.updateDownload(id,"cancelled");store.updateDownload(id,"running",bytes=20);assertEquals("A delayed worker report overwrote Cancel","cancelled",store.download(id).status)
  }finally{store.deleteDownload(id)}
 }
 @Test fun completedTransferCannotBeReactivatedByAStaleControl(){
  val id=store.addDownload("https://download-fixture.test/episode.mp4","Finished race fixture")
  try{store.updateDownload(id,"running");store.updateDownload(id,"complete",bytes=100,total=100);store.updateDownload(id,"paused");store.updateDownload(id,"queued");assertEquals("A stale user control reactivated a finished transfer","complete",store.download(id).status)}finally{store.deleteDownload(id)}
 }
}
