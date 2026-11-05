package app.aniverse.tablet

import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import androidx.media3.common.Player
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class OfflinePlaybackTest {
 private val instrumentation=InstrumentationRegistry.getInstrumentation()
 private val context=instrumentation.targetContext
 private val store get()=(context.applicationContext as TabletApplication).offline
 private fun fixture(name:String)=Uri.parse("content://${context.packageName}.fixtures/$name")
 private fun prepare(){val folder=File(context.cacheDir,"offline-fixtures").apply{mkdirs()};instrumentation.context.assets.open("clip.mp4").use{input->File(folder,"clip.mp4").outputStream().use{input.copyTo(it)}};File(folder,"sub.srt").writeText("1\n00:00:00,000 --> 00:00:30,000\nFlight subtitle fixture\n");File(folder,"sub.vtt").writeText("WEBVTT\n\n00:00.000 --> 00:30.000\nFlight VTT fixture\n");File(folder,"large.srt").writeText("1\n00:00:00,000 --> 00:00:30,000\n"+"x".repeat(4*1024*1024))}
 private fun waitUntil(message:String,condition:()->Boolean){val end=SystemClock.uptimeMillis()+15000;while(SystemClock.uptimeMillis()<end){if(condition())return;SystemClock.sleep(100)};fail(message)}
 private fun <T> main(block:()->T):T {val value=AtomicReference<T>();instrumentation.runOnMainSync{value.set(block())};return value.get()}
 @Test fun importsSubtitlesAreBoundedAndRemovalKeepsOriginal(){
  prepare();val result=store.importVideo(fixture("clip.mp4"));val id=result.getString("id");val original=File(context.cacheDir,"offline-fixtures/clip.mp4")
  try{
   assertTrue(store.video(id).canonicalPath.startsWith(context.filesDir.canonicalPath+File.separator));assertEquals(original.length(),store.video(id).length());assertTrue(store.list().getLong("usedBytes")>=original.length())
   store.importSubtitle(id,fixture("sub.srt"));assertEquals("vtt",store.subtitle(id)!!.extension)
   store.importSubtitle(id,fixture("sub.vtt"));assertEquals("vtt",store.subtitle(id)!!.extension)
   try{store.importSubtitle(id,fixture("large.srt"));fail("Oversized subtitle accepted")}catch(expected:IllegalArgumentException){}
   assertEquals("vtt",store.subtitle(id)!!.extension)
   try{store.video("../../private");fail("Path traversal accepted")}catch(expected:IllegalArgumentException){}
  }finally{val video=store.video(id);val subtitle=store.subtitle(id);store.remove(id);assertFalse(video.exists());assertFalse(subtitle?.exists()==true);assertTrue(original.exists())}
 }
 @Test fun realLocalFramesSubtitlesResumeAndTouchLockWork(){
  prepare();val id=store.importVideo(fixture("clip.mp4")).getString("id");store.importSubtitle(id,fixture("sub.srt"));store.savePosition(id,2000,0)
  println("SUBTITLE_INPUT="+store.subtitle(id)!!.readText())
  val parsed=java.util.ArrayList<androidx.media3.extractor.text.CuesWithTiming>()
  val data=store.subtitle(id)!!.readBytes();androidx.media3.extractor.text.webvtt.WebvttParser().parse(data,0,data.size,androidx.media3.extractor.text.SubtitleParser.OutputOptions.allCues()){parsed.add(it)}
  assertTrue("Fixture did not parse: "+parsed.toString(),parsed.any{it.cues.any{cue->cue.text.toString().contains("Flight subtitle fixture")}})
  var activity:OfflinePlayerActivity?=null
  try{
   activity=instrumentation.startActivitySync(Intent(context,OfflinePlayerActivity::class.java).putExtra("id",id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as OfflinePlayerActivity
   val current=activity
   main{current.player!!.play()}
   waitUntil("Local video never decoded advancing frames"){main{val player=current.player!!;player.videoDecoderCounters?.ensureUpdated();player.currentPosition>3000&&player.videoSize.width>0&&(player.videoDecoderCounters?.renderedOutputBufferCount ?: 0)>3}}
   try{waitUntil("SRT text never reached the player"){main{current.player!!.currentCues.cues.any{it.text.toString().contains("Flight subtitle fixture")}}}}catch(error:AssertionError){println("TEXT_TRACK_DIAGNOSTIC="+main{current.player!!.currentTracks.groups.map{group->"type=${group.type},selected=${group.isSelected},formats="+(0 until group.length).map{group.getTrackFormat(it).toString()}}.toString()});println("CURRENT_CUES="+main{current.player!!.currentCues.cues.map{it.text.toString()}.toString()}+" POS="+main{current.player!!.currentPosition.toString()});throw error}
   for(target in listOf(15000L,5000L,25000L)){
    val beforeFrames=main{current.player!!.videoDecoderCounters!!.renderedOutputBufferCount}
    main{current.player!!.seekTo(target);current.player!!.play()}
    waitUntil("Seek never decoded beyond its masked position"){main{val p=current.player!!;p.videoDecoderCounters?.ensureUpdated();p.playbackState==Player.STATE_READY&&p.currentPosition>=target+750&&p.currentPosition<target+5000&&(p.videoDecoderCounters?.renderedOutputBufferCount ?: 0)>beforeFrames+3}}
    try{waitUntil("Caption disappeared after seeking within its cue"){main{current.player!!.currentCues.cues.any{it.text.toString().contains("Flight subtitle fixture")}}}}catch(error:AssertionError){println("SEEK_DIAGNOSTIC="+main{val p=current.player!!;"target=$target,pos=${p.currentPosition},duration=${p.duration},state=${p.playbackState},playing=${p.isPlaying},cues=${p.currentCues.cues},tracks=${p.currentTracks.groups.map{it.isSelected}}"});throw error}
   }
   main{current.player!!.pause();current.player!!.seekTo(12000)}
   waitUntil("Paused seek lost its active caption"){main{val p=current.player!!;p.playbackState==Player.STATE_READY&&!p.playWhenReady&&p.currentPosition==12000L&&p.currentCues.cues.any{it.text.toString().contains("Flight subtitle fixture")}}}
   main{val p=current.player!!;p.trackSelectionParameters=p.trackSelectionParameters.buildUpon().setTrackTypeDisabled(androidx.media3.common.C.TRACK_TYPE_TEXT,true).build();p.seekTo(5000)}
   waitUntil("Seeking re-enabled disabled captions"){main{val p=current.player!!;p.playbackState==Player.STATE_READY&&!p.currentTracks.isTypeSelected(androidx.media3.common.C.TRACK_TYPE_TEXT)&&p.currentCues.cues.isEmpty()&&!p.playWhenReady}}
   main{val p=current.player!!;p.trackSelectionParameters=p.trackSelectionParameters.buildUpon().setTrackTypeDisabled(androidx.media3.common.C.TRACK_TYPE_TEXT,false).build();p.seekTo(15000)}
   waitUntil("Re-enabled captions did not return after paused seek"){main{val p=current.player!!;p.playbackState==Player.STATE_READY&&p.currentCues.cues.any{it.text.toString().contains("Flight subtitle fixture")}}}
   val location=IntArray(2);val video=main{current.window.decorView.findViewWithTag<View>("unused") ?: (current.window.decorView as ViewGroup).let{findPlayer(it)}}
   main{video.getLocationOnScreen(location)}
   fun doubleTap(x:Float){repeat(2){val time=SystemClock.uptimeMillis();instrumentation.sendPointerSync(MotionEvent.obtain(time,time,MotionEvent.ACTION_DOWN,x,location[1]+video.height*.5f,0));instrumentation.sendPointerSync(MotionEvent.obtain(time,time+35,MotionEvent.ACTION_UP,x,location[1]+video.height*.5f,0));SystemClock.sleep(70)}}
   doubleTap(location[0]+video.width*.85f)
   waitUntil("Double tap did not seek forward"){main{current.player!!.currentPosition>=24000}}
   val lock=main{findButton(current.window.decorView,"Lock touches")!!};main{lock.performClick()};val lockedAt=main{current.player!!.currentPosition};doubleTap(location[0]+video.width*.85f);SystemClock.sleep(400);assertTrue(kotlin.math.abs(main{current.player!!.currentPosition}-lockedAt)<500)
   main{findButton(current.window.decorView,"Unlock touches")!!.performClick();current.player!!.seekTo(7000);current.finish()};activity=null
   waitUntil("Local progress was not saved"){store.position(id)>=6500}
   assertTrue(store.video(id).exists())
  }finally{activity?.let{main{it.finish()}};store.remove(id)}
 }
 private fun findPlayer(view:View):View {if(view is androidx.media3.ui.PlayerView)return view;if(view is ViewGroup)for(i in 0 until view.childCount){val child=runCatching{findPlayer(view.getChildAt(i))}.getOrNull();if(child!=null)return child};error("Player view missing")}
 private fun findButton(view:View,text:String):Button?{if(view is Button&&view.text.toString()==text)return view;if(view is ViewGroup)for(i in 0 until view.childCount)findButton(view.getChildAt(i),text)?.let{return it};return null}
}
