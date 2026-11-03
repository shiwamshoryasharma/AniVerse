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
class DownloadService:Service() {
    private val executor=Executors.newSingleThreadExecutor()
    private lateinit var store:OfflineStore
    private lateinit var policy:NetworkPolicy
    override fun onCreate(){super.onCreate();store=(application as TabletApplication).offline;policy=NetworkPolicy(if(BuildConfig.DEBUG)BuildConfig.TEST_ORIGIN else "");getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("downloads","Episode downloads",NotificationManager.IMPORTANCE_LOW))}
    override fun onStartCommand(intent:Intent?,flags:Int,startId:Int):Int {
        startForeground(410,notification("Preparing downloads",0,0),ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        executor.execute{
            try{while(true){val id=store.queued() ?: break;transfer(id)}}
            finally{if(stopSelfResult(startId))stopForeground(STOP_FOREGROUND_REMOVE)}
        }
        return START_NOT_STICKY
    }
    override fun onTimeout(startId:Int,fgsType:Int){store.pauseInterrupted();for((id,connection)in connections){runCatching{store.updateDownload(id,"paused",bytes=store.partial(id).length())};connection.disconnect()};stopForeground(STOP_FOREGROUND_REMOVE);stopSelf()}
    override fun onBind(intent:Intent?):IBinder?=null
    private fun notification(title:String,bytes:Long,total:Long):Notification {
        val open=PendingIntent.getActivity(this,0,Intent(this,MainActivity::class.java).putExtra("route","/downloads"),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this,"downloads").setSmallIcon(android.R.drawable.stat_sys_download).setContentTitle(title.take(80)).setContentText(if(total>0)"${bytes*100/total}% · ${bytes/(1024*1024)} / ${total/(1024*1024)} MiB" else "${bytes/(1024*1024)} MiB saved").setContentIntent(open).setOnlyAlertOnce(true).setOngoing(true).setProgress(100,if(total>0)(bytes*100/total).toInt().coerceIn(0,100) else 0,total<=0).build()
    }
    private fun open(url:String,offset:Long,validator:String):HttpURLConnection {
        var target=url
        repeat(6){
            require(policy.allow(target)){"This download address is blocked by source protection."}
            val connection=URL(target).openConnection() as HttpURLConnection
            connection.instanceFollowRedirects=false;connection.connectTimeout=15000;connection.readTimeout=15000
            connection.setRequestProperty("Accept-Encoding","identity");connection.setRequestProperty("User-Agent","AniVerse-Android/0.1.0")
            if(offset>0){connection.setRequestProperty("Range","bytes=$offset-");connection.setRequestProperty("If-Range",validator)}
            val status=connection.responseCode
            if(status in listOf(301,302,303,307,308)){
                val location=connection.getHeaderField("Location");connection.disconnect();require(!location.isNullOrBlank()){"The server sent an invalid redirect."};target=URI(target).resolve(location).toString()
            } else return connection
        }
        error("Too many download redirects.")
    }
    private fun transfer(id:String) {
        val record=store.download(id);val part=store.partial(id)
        var bytes=if(record.resumable)part.length() else 0L
        if(!store.updateDownload(id,"running",bytes=bytes))return
        var connection:HttpURLConnection?=null
        try {
            if(record.total>0&&part.length()==record.total){store.complete(id,record.title,part);return}
            if(!record.resumable&&part.exists())check(part.delete()){"Could not restart partial download."}
            val validator=record.etag.takeIf{it.isNotBlank()&&!it.startsWith("W/")} ?: record.modified
            if(bytes>0&&validator.isBlank()){part.delete();bytes=0}
            connection=open(record.url,bytes,validator);connections[id]=connection
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
                    if(store.download(id).status!="running")break
                    val read=input.read(buffer);if(read<0)break
                    require(bytes+read<=64L*1024*1024*1024&&(total==0L||bytes+read<=total)){"The server exceeded its declared download size."}
                    require(StatFs(part.parent!!).availableBytes>64L*1024*1024){"Low storage: pause the download and free some space."}
                    output.write(buffer,0,read);bytes+=read
                    val now=System.currentTimeMillis()
                    if(now-lastReport>=500){
                        if(store.download(id).status!="running")break
                        store.updateDownload(id,"running",bytes=bytes);speed[id]=(bytes-initialBytes)*1000/(now-started).coerceAtLeast(1);lastReport=now
                        getSystemService(NotificationManager::class.java).notify(410,notification(record.title,bytes,total))
                    }
                }
                output.fd.sync()
            }}
            val state=store.download(id).status
            if(state=="cancelled"){part.delete();store.deleteDownload(id);return}
            if(state!="running")return
            require(bytes>0&&(total==0L||bytes==total)){"The transfer ended early. Resume or retry this download."}
            store.complete(id,record.title,part);store.updateDownload(id,"complete",bytes=bytes,total=bytes)
        }catch(error:Exception){
            val state=runCatching{store.download(id).status}.getOrNull()
            if(state=="cancelled"){part.delete();store.deleteDownload(id)}
            else if(state=="running")store.updateDownload(id,"failed",bytes=part.length(),error=error.message ?: "Download failed.")
        }finally{connections.remove(id);speed.remove(id);connection?.disconnect()}
    }
    override fun onDestroy(){store.pauseInterrupted();for((id,connection)in connections){runCatching{if(store.download(id).status=="running")store.updateDownload(id,"paused",bytes=store.partial(id).length())};connection.disconnect()};policy.close();executor.shutdownNow();super.onDestroy()}
    companion object {
        val speed=ConcurrentHashMap<String,Long>()
        private val connections=ConcurrentHashMap<String,HttpURLConnection>()
        fun start(context:Context){context.startForegroundService(Intent(context,DownloadService::class.java))}
        fun interrupt(id:String){connections[id]?.disconnect()}
    }
}
