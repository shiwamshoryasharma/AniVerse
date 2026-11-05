package app.aniverse.tablet

import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import androidx.media3.common.MediaItem
import androidx.media3.common.StreamKey
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.ByteArrayDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSourceInputStream
import androidx.media3.datasource.DataSpec
import androidx.media3.exoplayer.hls.offline.HlsDownloader
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class SourceDownloadTest {
    private val instrumentation=InstrumentationRegistry.getInstrumentation()
    private val context=instrumentation.targetContext
    private val store get()=(context.applicationContext as TabletApplication).offline
    private val origin="https://media-fixture.example.test/"
    private fun <T> main(block:()->T):T{val result=AtomicReference<T>();instrumentation.runOnMainSync{result.set(block())};return result.get()}
    private fun waitUntil(message:String,check:()->Boolean){val end=SystemClock.uptimeMillis()+15000;while(SystemClock.uptimeMillis()<end){if(check())return;SystemClock.sleep(100)};fail(message)}
    private fun bytes(name:String)=instrumentation.context.assets.open(name).use{it.readBytes()}
    private fun hash(bytes:ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it.toInt() and 255)}
    /** Deliberately has no HTTP client. Unexpected resources are rejected in-process. */
    private fun fixtureSource()=DataSource.Factory{
        object:BaseDataSource(false){
            private var delegate:ByteArrayDataSource?=null
            override fun open(spec:DataSpec):Long{
                require(spec.uri.toString().startsWith(origin))
                val name=spec.uri.lastPathSegment ?: error("Missing fixture")
                val allowed=JSONObject(String(bytes("hls-fixtures.json")))
                require(allowed.has(name))
                val payload=bytes(name)
                if(name.endsWith(".m3u8"))HlsChecks.validate(payload)
                transferInitializing(spec)
                delegate=ByteArrayDataSource(payload);val length=delegate!!.open(spec);transferStarted(spec);return length
            }
            override fun read(buffer:ByteArray,offset:Int,length:Int):Int=delegate!!.read(buffer,offset,length).also{if(it>0)bytesTransferred(it)}
            override fun getUri():Uri?=delegate?.uri
            override fun close(){delegate?.close();delegate=null;transferEnded()}
        }
    }
    private fun saveAndPlay(manifest:String,keys:List<StreamKey>,expected:(String)->Boolean){
        val url=origin+manifest
        val id=store.addSourceDownload(SourceMediaRequest(url,"","FixtureAgent","fixture=private","hls"),"Offline HLS fixture")
        var activity:OfflinePlayerActivity?=null
        try{
            assertTrue(store.updateDownload(id,"running"))
            var size=0L
            OfflineHls(context,store.hlsDirectory(id)).use{cache->
                val item=MediaItem.Builder().setUri(url).setStreamKeys(keys).build()
                val downloader=HlsDownloader.Factory(cache.downloading(fixtureSource())).create(item)
                downloader.download(null)
                val fixtures=JSONObject(String(bytes("hls-fixtures.json")))
                for(name in fixtures.keys().asSequence().filter(expected)){
                    val spec=DataSpec.Builder().setUri(origin+name).build()
                    val actual=DataSourceInputStream(cache.playback().createDataSource(),spec).use{it.readBytes()}
                    assertEquals("Offline cached bytes changed for "+name,fixtures.getString(name),hash(actual))
                }
                size=cache.cache.cacheSpace
                store.completeHls(id,"Offline HLS fixture",size,JSONObject().put("url",url).put("keys",JSONArray().apply{
                    keys.forEach{put(JSONArray().put(it.groupIndex).put(it.streamIndex))}
                }))
            }
            assertEquals("complete",store.download(id).status)
            assertNull("Completed download retained source cookie context",store.download(id).request)
            assertTrue(size>0)
            val captions=File(context.cacheDir,"offline-fixtures").apply{mkdirs()}
            File(captions,"sub.vtt").writeText("WEBVTT\n\n00:00.000 --> 00:12.000\nOffline HLS sidecar fixture\n")
            store.importSubtitle(id,Uri.parse("content://"+context.packageName+".fixtures/sub.vtt"))
            activity=instrumentation.startActivitySync(Intent(context,OfflinePlayerActivity::class.java).putExtra("id",id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as OfflinePlayerActivity
            val current=activity
            waitUntil("Cached HLS never rendered advancing offline video"){
                main{val p=current.player ?: return@main false;p.videoDecoderCounters?.ensureUpdated()
                    p.currentPosition>1500&&p.videoSize.width>0&&(p.videoDecoderCounters?.renderedOutputBufferCount ?: 0)>3}
            }
            waitUntil("Selected HLS sidecar did not render"){main{current.player!!.currentCues.cues.any{it.text.toString().contains("Offline HLS sidecar fixture")}}}
            main{current.player!!.seekTo(5000);current.player!!.play()}
            waitUntil("Selected HLS sidecar failed after seek"){main{val p=current.player!!;p.currentPosition>5500&&p.currentCues.cues.any{it.text.toString().contains("Offline HLS sidecar fixture")}}}
            main{current.finish()};activity=null;instrumentation.waitForIdleSync()
        }finally{
            activity?.let{main{it.finish()};instrumentation.waitForIdleSync()}
            if(runCatching{store.video(id)}.isSuccess)store.remove(id)
            store.deleteDownload(id)
        }
    }
    @Test fun clearHlsSegmentsMatchAndPlayWithCacheOnlyUpstream(){
        saveAndPlay("hls-clear.m3u8",emptyList()){it.startsWith("hls-clear")}
    }
    @Test fun ordinaryAes128MasterKeysAndSegmentsMatchAndPlayOffline(){
        saveAndPlay("hls-master.m3u8",listOf(StreamKey(0,0))){it.startsWith("hls-aes")||it=="hls-master.m3u8"}
    }
    @Test fun sourceQueueDeduplicatesAndCancelledPublicationCannotSaveAnEpisode(){
        val request=SourceMediaRequest(origin+"hls-clear.m3u8","","FixtureAgent",null,"hls")
        val id=store.addSourceDownload(request,"Cancellation fixture")
        try{
            assertEquals(id,store.addSourceDownload(request,"Duplicate tap"))
            assertTrue(store.updateDownload(id,"running"));assertTrue(store.updateDownload(id,"paused"))
            assertFalse(store.updateDownload(id,"running",bytes=123))
            try{store.completeHls(id,"Late result",10,JSONObject().put("url",request.url).put("keys",JSONArray()));fail("Paused result published")}catch(_:IllegalStateException){}
            assertTrue(store.updateDownload(id,"cancelled"))
            try{store.completeHls(id,"Late result",10,JSONObject().put("url",request.url).put("keys",JSONArray()));fail("Cancelled result published")}catch(_:IllegalStateException){}
            assertTrue(runCatching{store.video(id)}.isFailure)
        }finally{store.deleteDownload(id)}
    }
    @Test fun offlineGrantAllowsOnlyTheSelectedCaptionAndNeverOtherSchemes(){
        val id=UUID.randomUUID().toString()
        val selected=File(context.cacheDir,"caption-"+id+".vtt").apply{writeText("WEBVTT\\n")}
        val other=File(context.cacheDir,"other-"+id+".txt").apply{writeText("unselected private bytes")}
        val directory=store.hlsDirectory(id)
        try{
            OfflineHls(context,directory).use{cache->
                val factory=cache.playback(selected)
                val allowed=DataSpec.Builder().setUri(Uri.fromFile(selected.canonicalFile)).build()
                assertArrayEquals(selected.readBytes(),DataSourceInputStream(factory.createDataSource(),allowed).use{it.readBytes()})
                for(uri in listOf(Uri.fromFile(other.canonicalFile),Uri.parse("content://"+context.packageName+".fixtures/clip.mp4"),
                        Uri.parse("asset:///clip.mp4"),Uri.parse("https://never-requested.example.test/missing.ts"))){
                    var rejected=false
                    try{DataSourceInputStream(factory.createDataSource(),DataSpec.Builder().setUri(uri).build()).use{it.readBytes()}}
                    catch(_:Exception){rejected=true}
                    assertTrue("An ungranted resource bypassed cache-only playback",rejected)
                }
            }
        }finally{selected.delete();other.delete();directory.deleteRecursively()}
    }
    @Test fun recoveryUsesTransferOwnershipWithoutParsingPrivateSourceContext(){
        val token=UUID.randomUUID().toString()
        val name="offline-recovery-"+token+".db"
        val root=File(context.cacheDir,"offline-recovery-"+token).apply{check(mkdirs())}
        val isolated=object:ContextWrapper(context){override fun getFilesDir():File=root}
        val recovery=OfflineStore(isolated,name)
        try{
            val transfer=recovery.addDownload(origin+"pending.mp4","Owned transfer")
            val invalidContext="{invalid private source request"
            recovery.writableDatabase.execSQL("UPDATE downloads SET status='paused',source_request=? WHERE id=?",arrayOf(invalidContext,transfer))
            val owned=File(recovery.hlsDirectory(transfer).apply{check(mkdirs())},"owned.cache").apply{writeBytes(byteArrayOf(1,2,3))}
            val partial=recovery.partial(transfer).apply{writeBytes(byteArrayOf(4,5))}
            val orphan=recovery.hlsDirectory(UUID.randomUUID().toString()).apply{check(mkdirs())}
            File(orphan,"orphan.cache").writeText("unowned")
            val videos=mutableListOf<Pair<String,File>>()
            for(kind in listOf("direct","hls")){
                val id=UUID.randomUUID().toString()
                val video=File(root,"offline/"+id+".video").apply{writeBytes(byteArrayOf(6,7,8))}
                recovery.writableDatabase.execSQL("INSERT INTO videos(id,title,filename,bytes,kind,added_at) VALUES(?,?,?,?,?,1)",
                    arrayOf(id,"Existing saved episode",video.name,video.length(),kind))
                videos.add(id to video)
            }
            val savedHls=File(recovery.hlsDirectory(videos[1].first).apply{check(mkdirs())},"saved.cache").apply{writeBytes(byteArrayOf(9,10))}

            recovery.recoverStorage()

            assertArrayEquals(byteArrayOf(1,2,3),owned.readBytes())
            assertArrayEquals(byteArrayOf(4,5),partial.readBytes())
            assertFalse("An unowned HLS directory survived recovery",orphan.exists())
            for((id,video)in videos){assertEquals(video.canonicalFile,recovery.video(id));assertArrayEquals(byteArrayOf(6,7,8),video.readBytes())}
            assertArrayEquals(byteArrayOf(9,10),savedHls.readBytes())
            recovery.readableDatabase.rawQuery("SELECT status,source_request FROM downloads WHERE id=?",arrayOf(transfer)).use{
                assertTrue(it.moveToFirst());assertEquals("paused",it.getString(0));assertEquals(invalidContext,it.getString(1))
            }
        }finally{
            recovery.close();context.deleteDatabase(name)
            check(root.canonicalFile.parentFile==context.cacheDir.canonicalFile)
            check(root.deleteRecursively())
        }
    }
    @Test fun malformedQueuedRequestFailsPrivatelyAndTheRealWorkerLoaderAdvances(){
        val token=UUID.randomUUID().toString()
        val name="offline-queue-load-"+token+".db"
        val root=File(context.cacheDir,"offline-queue-load-"+token).apply{check(mkdirs())}
        val isolated=object:ContextWrapper(context){override fun getFilesDir():File=root}
        val queue=OfflineStore(isolated,name)
        val invalidContext="{malformed private cookie=session-secret"
        fun corrupt(id:String){queue.writableDatabase.execSQL("UPDATE downloads SET source_request=? WHERE id=?",arrayOf(invalidContext,id))}
        fun state(id:String)=queue.readableDatabase.rawQuery("SELECT status,error FROM downloads WHERE id=?",arrayOf(id)).use{
            assertTrue(it.moveToFirst());it.getString(0) to if(it.isNull(1))null else it.getString(1)
        }
        try{
            val bad=queue.addDownload(origin+"malformed.mp4","Unreadable record");corrupt(bad)
            val valid=queue.addDownload(origin+"valid.mp4","Next valid record")
            assertEquals(bad,queue.queued())
            assertNull(DownloadService.loadQueuedRecord(queue,bad))
            assertEquals("failed",state(bad).first)
            assertEquals("The saved download could not be read. Reopen the episode and download it again.",state(bad).second)
            assertFalse(state(bad).second!!.contains("session-secret"))
            assertEquals(valid,queue.queued())
            assertEquals(valid,DownloadService.loadQueuedRecord(queue,valid)!!.id)
            assertTrue(queue.updateDownload(valid,"running"));assertNull(queue.queued())

            for(status in listOf("paused","cancelled","complete")){
                val id=queue.addDownload(origin+status+".mp4","Concurrent state change")
                if(status=="complete")assertTrue(queue.updateDownload(id,"running"))
                assertTrue(queue.updateDownload(id,status));corrupt(id)
                assertNull(DownloadService.loadQueuedRecord(queue,id))
                assertEquals(status to null,state(id))
            }
        }finally{
            queue.close();context.deleteDatabase(name)
            check(root.canonicalFile.parentFile==context.cacheDir.canonicalFile)
            check(root.deleteRecursively())
        }
    }
    @Test fun schemaOneMigrationPreservesFilesProgressAndDownloadState(){
        val name="offline-migration-"+UUID.randomUUID()+".db"
        val id=UUID.randomUUID().toString()
        val folder=File(context.filesDir,"offline").apply{mkdirs()}
        val video=File(folder,id+".video");video.writeBytes(bytes("clip.mp4"))
        val db=context.openOrCreateDatabase(name,Context.MODE_PRIVATE,null)
        db.execSQL("CREATE TABLE videos(id TEXT PRIMARY KEY,title TEXT NOT NULL,filename TEXT NOT NULL,bytes INTEGER NOT NULL,duration INTEGER NOT NULL DEFAULT 0,position INTEGER NOT NULL DEFAULT 0,subtitle TEXT,subtitle_name TEXT,added_at INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE downloads(id TEXT PRIMARY KEY,title TEXT NOT NULL,url TEXT NOT NULL,status TEXT NOT NULL,bytes INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL DEFAULT 0,etag TEXT NOT NULL DEFAULT '',modified TEXT NOT NULL DEFAULT '',resumable INTEGER NOT NULL DEFAULT 0,error TEXT,added_at INTEGER NOT NULL)")
        db.execSQL("INSERT INTO videos(id,title,filename,bytes,position,added_at) VALUES(?,?,?,?,?,?)",arrayOf(id,"Retained episode",video.name,video.length(),321L,1L))
        val pending=UUID.randomUUID().toString()
        db.execSQL("INSERT INTO downloads(id,title,url,status,bytes,added_at) VALUES(?,?,?,'paused',123,1)",arrayOf(pending,"Retained transfer",origin+"old.mp4"))
        db.version=1;db.close()
        val migrated=OfflineStore(context,name)
        try{
            assertEquals(321L,migrated.position(id));assertEquals(video.readBytes().size.toLong(),migrated.video(id).length())
            assertNull(migrated.hlsMetadata(id));assertEquals("paused",migrated.download(pending).status)
            assertEquals(123L,migrated.download(pending).bytes);assertNull(migrated.download(pending).request)
            val secret=SourceMediaRequest(origin+"new.mp4?token=private","https://site.example.test/episode","FixtureAgent","session=private","direct","null")
            val added=migrated.addSourceDownload(secret,"Private context")
            assertEquals(secret,migrated.download(added).request)
            assertFalse(migrated.downloads().toString().contains("session=private"));assertFalse(migrated.downloads().toString().contains("token=private"))
            migrated.deleteDownload(added)
        }finally{migrated.remove(id);migrated.deleteDownload(pending);migrated.close();context.deleteDatabase(name)}
    }
}
