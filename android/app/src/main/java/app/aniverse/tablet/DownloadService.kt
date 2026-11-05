package app.aniverse.tablet

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.StatFs
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** One background transfer at a time: persisted queue, validator-aware Range resume and bounded IO. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class DownloadService:Service() {
    private val executor=Executors.newSingleThreadExecutor()
    private lateinit var store:OfflineStore
    private lateinit var policy:NetworkPolicy
    override fun onCreate(){super.onCreate();store=(application as TabletApplication).offline;policy=NetworkPolicy(if(BuildConfig.DEBUG)BuildConfig.TEST_ORIGIN else "",additionalDebugOrigin=if(BuildConfig.DEBUG&&BuildConfig.TEST_ORIGIN.isNotBlank())BuildConfig.TEST_MEDIA_ORIGIN else "");getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("downloads","Episode downloads",NotificationManager.IMPORTANCE_LOW))}
    override fun onStartCommand(intent:Intent?,flags:Int,startId:Int):Int {
        startForeground(410,notification("Preparing downloads",0,0),ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        executor.execute{
            try{while(true){val id=store.queued() ?: break;transfer(id)}}
            finally{if(stopSelfResult(startId))stopForeground(STOP_FOREGROUND_REMOVE)}
        }
        return START_NOT_STICKY
    }
    override fun onTimeout(startId:Int,fgsType:Int){for(live in liveness.values)live.cancel();store.pauseInterrupted();for(downloader in hlsDownloads.values)downloader.cancel();for((id,connection)in connections){runCatching{store.updateDownload(id,"paused",bytes=store.partial(id).length())};connection.disconnect()};stopForeground(STOP_FOREGROUND_REMOVE);stopSelf()}
    override fun onBind(intent:Intent?):IBinder?=null
    private fun notification(title:String,bytes:Long,total:Long):Notification {
        val open=PendingIntent.getActivity(this,0,Intent(this,MainActivity::class.java).putExtra("route","/downloads"),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this,"downloads").setSmallIcon(android.R.drawable.stat_sys_download).setContentTitle(title.take(80)).setContentText(if(total>0)"${bytes*100/total}% · ${bytes/(1024*1024)} / ${total/(1024*1024)} MiB" else "${bytes/(1024*1024)} MiB saved").setContentIntent(open).setOnlyAlertOnce(true).setOngoing(true).setProgress(100,if(total>0)(bytes*100/total).toInt().coerceIn(0,100) else 0,total<=0).build()
    }
    private fun open(id:String,url:String,offset:Long,validator:String,source:SourceMediaRequest?,live:TransferLiveness):HttpURLConnection {
        var target=url
        repeat(6){
            check(live.isActive()){"Source download stopped."}
            require(policy.allow(target)){"This download address is blocked by source protection."}
            val connection=URL(target).openConnection() as HttpURLConnection
            connections[id]=connection
            check(live.isActive()){"Source download stopped."}
            connection.instanceFollowRedirects=false;connection.connectTimeout=15000;connection.readTimeout=15000
            connection.setRequestProperty("Accept-Encoding","identity");connection.setRequestProperty("User-Agent","AniVerse-Android/"+BuildConfig.VERSION_NAME)
            source?.headersFor(target)?.forEach{(name,value)->connection.setRequestProperty(name,value)}
            if(offset>0){connection.setRequestProperty("Range","bytes=$offset-");connection.setRequestProperty("If-Range",validator)}
            val status=connection.responseCode
            if(status in listOf(301,302,303,307,308)){
                val location=connection.getHeaderField("Location");connection.disconnect();require(!location.isNullOrBlank()){"The server sent an invalid redirect."};target=URI(target).resolve(location).toString()
            } else return connection
        }
        error("Too many download redirects.")
    }
    private fun transfer(id:String) {
        val record=loadQueuedRecord(store,id) ?: return
        val live=TransferLiveness({store.isRunning(id)})
        if(liveness.putIfAbsent(id,live)!=null)return
        try{
            if(record.request?.kind=="hls")transferHls(id,record,live) else transferDirect(id,record,live)
        }finally{liveness.remove(id,live)}
    }
    private fun transferDirect(id:String,record:DownloadRecord,live:TransferLiveness){
        val part=store.partial(id)
        var bytes=if(record.resumable)part.length() else 0L
        if(!store.updateDownload(id,"running",bytes=bytes))return
        var connection:HttpURLConnection?=null
        try {
            if(record.total>0&&part.length()==record.total){if(live.isActive())store.complete(id,record.title,part);return}
            if(!record.resumable&&part.exists())check(part.delete()){"Could not restart partial download."}
            val validator=record.etag.takeIf{it.isNotBlank()&&!it.startsWith("W/")} ?: record.modified
            if(bytes>0&&validator.isBlank()){part.delete();bytes=0}
            connection=open(id,record.url,bytes,validator,record.request,live);connections[id]=connection
            val status=connection.responseCode;require(status==200||status==206){"Download server returned HTTP $status. Retry or choose a fresh file link."}
            val mime=connection.contentType?.substringBefore(';')?.lowercase() ?: ""
            val disposition=connection.getHeaderField("Content-Disposition") ?: ""
            val fileHint=URI(connection.url.toString()).path+" "+disposition
            require(mime.startsWith("video/")||(mime=="application/octet-stream"&&Regex("\\.(mp4|mkv|webm|m4v|mov)(?:[\\s\";]|$)",RegexOption.IGNORE_CASE).containsMatchIn(fileHint))){"Choose a direct video file or the website's own video download link."}
            require(!mime.contains("mpegurl")&&!mime.contains("dash+xml")){"Streaming playlists are not offline video files."}
            val etag=connection.getHeaderField("ETag") ?: "";val modified=connection.getHeaderField("Last-Modified") ?: ""
            val contentLength=connection.contentLengthLong
            val range=connection.getHeaderField("Content-Range")
            val plan=TransferChecks.validate(status,range,contentLength,bytes,record.total,record.etag,etag)
            bytes=plan.offset;val total=plan.total
            require(total==0L||StatFs(part.parent!!).availableBytes>total-bytes+64L*1024*1024){"Not enough free storage for this video."}
            val resumable=(connection.getHeaderField("Accept-Ranges")?.lowercase()=="bytes"||status==206)&&(etag.isNotBlank()&&!etag.startsWith("W/")||modified.isNotBlank())&&total>0
            store.updateDownload(id,"running",bytes=bytes,total=total,etag=etag,modified=modified,resumable=resumable)
            val started=System.currentTimeMillis();val initialBytes=bytes;var lastReport=0L
            connection.inputStream.use{input->RandomAccessFile(part,"rw").use{output->
                output.setLength(bytes);output.seek(bytes);val buffer=ByteArray(64*1024)
                while(true){
                    if(!live.isActive())break
                    val read=input.read(buffer);if(read<0)break
                    require(bytes+read<=64L*1024*1024*1024&&(total==0L||bytes+read<=total)){"The server exceeded its declared download size."}
                    require(StatFs(part.parent!!).availableBytes>64L*1024*1024){"Low storage: pause the download and free some space."}
                    output.write(buffer,0,read);bytes+=read
                    val now=System.currentTimeMillis()
                    if(now-lastReport>=500){
                        if(!live.isActive())break
                        store.updateDownload(id,"running",bytes=bytes);speed[id]=(bytes-initialBytes)*1000/(now-started).coerceAtLeast(1);lastReport=now
                        getSystemService(NotificationManager::class.java).notify(410,notification(record.title,bytes,total))
                    }
                }
                output.fd.sync()
            }}
            val state=store.download(id).status
            if(state=="cancelled"){part.delete();store.deleteDownload(id);return}
            if(state!="running"||!live.isActive())return
            require(bytes>0&&(total==0L||bytes==total)){"The transfer ended early. Resume or retry this download."}
            store.complete(id,record.title,part);store.updateDownload(id,"complete",bytes=bytes,total=bytes)
        }catch(error:Exception){
            val state=runCatching{store.download(id).status}.getOrNull()
            if(state=="cancelled"){part.delete();store.deleteDownload(id)}
            else if(state=="running")store.updateDownload(id,"failed",bytes=part.length(),error=downloadError(error))
        }finally{connections.remove(id)?.disconnect();speed.remove(id);connection?.disconnect()}
    }
    @androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
    private fun transferHls(id:String,record:DownloadRecord,live:TransferLiveness) {
        val request=checkNotNull(record.request)
        if(!store.updateDownload(id,"running"))return
        var saved:OfflineHls?=null
        try {
            saved=OfflineHls(this,store.hlsDirectory(id))
            val cache=saved
            val active={live.isActive()}
            val storage=TransferStorageChecks({StatFs(store.hlsDirectory(id).path).availableBytes})
            val manifests=ConcurrentHashMap.newKeySet<String>().apply{add(request.url)}
            val budget=SourceTransferBudget(initial=cache.cache.cacheSpace)
            val upstream=androidx.media3.datasource.DataSource.Factory {
                SourceHttpDataSource(request,policy,storage,active,manifests,budget){connection->
                    if(connection==null)connections.remove(id) else connections[id]=connection
                }
            }
            val factory=cache.downloading(upstream)
            var playlistBytes=0;var playlistCount=0
            fun loadPlaylist(address:String):androidx.media3.exoplayer.hls.playlist.HlsPlaylist{
                check(++playlistCount<=33){"This source has too many selected playlist tracks."}
                manifests.add(address)
                val source=factory.createDataSource()
                val spec=androidx.media3.datasource.DataSpec.Builder().setUri(address).build()
                val stream=androidx.media3.datasource.DataSourceInputStream(source,spec)
                return stream.use{input->
                    val output=java.io.ByteArrayOutputStream();val buffer=ByteArray(8192)
                    while(true){
                        check(active()){"Source download stopped."}
                        val count=input.read(buffer);if(count<0)break
                        playlistBytes+=count
                        require(output.size()+count<=HlsChecks.MAX_PLAYLIST_BYTES&&playlistBytes<=4*HlsChecks.MAX_PLAYLIST_BYTES){"Selected source playlists exceed the download budget."}
                        output.write(buffer,0,count)
                    }
                    val bytes=output.toByteArray();HlsChecks.validate(bytes)
                    val base=source.uri ?: android.net.Uri.parse(address)
                    manifests.add(base.toString());manifests.addAll(HlsChecks.playlistUris(bytes,base.toString()))
                    androidx.media3.exoplayer.hls.playlist.HlsPlaylistParser().parse(base,java.io.ByteArrayInputStream(bytes))
                }
            }
            // Validate fully assembled cached/network playlists, including after resume.
            val manifest=loadPlaylist(request.url)
            val keys=mutableListOf<androidx.media3.common.StreamKey>()
            if(manifest is androidx.media3.exoplayer.hls.playlist.HlsMultivariantPlaylist){
                require(manifest.variants.isNotEmpty()){"This HLS source has no video variant."}
                // Save one video variant plus its audio group, rather than every quality.
                keys.add(androidx.media3.common.StreamKey(0,0))
                val audio=manifest.variants[0].audioGroupId
                val children=linkedSetOf(manifest.variants[0].url.toString())
                manifest.audios.forEachIndexed{index,rendition->if(audio!=null&&rendition.groupId==audio){
                    keys.add(androidx.media3.common.StreamKey(1,index));rendition.url?.let{children.add(it.toString())}
                }}
                for(child in children)require(loadPlaylist(child) is androidx.media3.exoplayer.hls.playlist.HlsMediaPlaylist){"Nested master playlists are not supported for offline episodes."}
            }
            val media=androidx.media3.common.MediaItem.Builder().setUri(request.url).setStreamKeys(keys).build()
            val downloader=androidx.media3.exoplayer.hls.offline.HlsDownloader.Factory(factory)
                .setExecutor(java.util.concurrent.Executor{it.run()}).create(media)
            hlsDownloads[id]=downloader
            if(!active()){downloader.cancel();return}
            val started=System.currentTimeMillis();val initial=cache.cache.cacheSpace;var lastReport=0L
            downloader.download{total,bytes,_->
                check(active()){"Source download stopped."}
                require(bytes<=TransferChecks.MAX_FILE_BYTES){"This source episode exceeds the storage budget."}
                val now=System.currentTimeMillis()
                if(now-lastReport>=500){
                    val known=total.takeIf{it>0} ?: 0L
                    check(store.updateDownload(id,"running",bytes=bytes,total=known,resumable=true)){"Source download stopped."}
                    speed[id]=(bytes-initial).coerceAtLeast(0)*1000/(now-started).coerceAtLeast(1)
                    getSystemService(NotificationManager::class.java).notify(410,notification(record.title,bytes,known));lastReport=now
                }
            }
            if(!active()||!store.isRunning(id))return
            val bytes=cache.cache.cacheSpace
            require(bytes>0&&bytes<=TransferChecks.MAX_FILE_BYTES)
            val metadata=org.json.JSONObject().put("url",request.url).put("keys",org.json.JSONArray().apply{
                for(key in keys)put(org.json.JSONArray().put(key.groupIndex).put(key.streamIndex))
            })
            cache.close();saved=null
            store.completeHls(id,record.title,bytes,metadata)
        }catch(error:Exception){
            val state=runCatching{store.download(id).status}.getOrNull()
            if(state=="running")store.updateDownload(id,"failed",error=downloadError(error))
        }finally{
            hlsDownloads.remove(id);connections.remove(id);speed.remove(id)
            saved?.close()
            if(runCatching{store.download(id).status=="cancelled"}.getOrDefault(false))store.deleteDownload(id)
        }
    }
    private fun downloadError(error:Exception)=
        (error.message ?: "Source download failed.").replace(Regex("https?://[^\\s]+"),"[private media URL]").take(300)

    override fun onDestroy(){for(live in liveness.values)live.cancel();store.pauseInterrupted();for(downloader in hlsDownloads.values)downloader.cancel();for((id,connection)in connections){runCatching{if(store.download(id).status=="running")store.updateDownload(id,"paused",bytes=store.partial(id).length())};connection.disconnect()};policy.close();executor.shutdownNow();super.onDestroy()}
    companion object {
        val speed=ConcurrentHashMap<String,Long>()
        private val liveness=ConcurrentHashMap<String,TransferLiveness>()
        private val connections=ConcurrentHashMap<String,HttpURLConnection>()
        private val hlsDownloads=ConcurrentHashMap<String,androidx.media3.exoplayer.offline.Downloader>()
        internal fun loadQueuedRecord(store:OfflineStore,id:String):DownloadRecord?=try{
            store.download(id)
        }catch(_:Exception){
            // A corrupt private request must not trap the sequential queue on one item.
            // The conditional SQL leaves any concurrent pause/cancel/completion intact.
            store.failUnreadableQueuedDownload(id);null
        }
        fun start(context:Context){context.startForegroundService(Intent(context,DownloadService::class.java))}
        fun interrupt(id:String){liveness[id]?.cancel();hlsDownloads[id]?.cancel();connections[id]?.disconnect()}
    }
}
