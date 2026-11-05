package app.aniverse.tablet

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.StatFs
import android.provider.OpenableColumns
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

data class DownloadRecord(val id:String,val title:String,val url:String,val status:String,val bytes:Long,val total:Long,val etag:String,val modified:String,val resumable:Boolean,val request:SourceMediaRequest?=null)

/** Only opaque UUIDs cross the UI seam. All paths are app-private and canonicalized. */
class OfflineStore(private val context:Context,databaseName:String="offline.db"):SQLiteOpenHelper(context,databaseName,null,3) {
    private val directory=File(context.filesDir,"offline").apply{mkdirs()}
    override fun onCreate(db:SQLiteDatabase){
        db.execSQL("CREATE TABLE videos(id TEXT PRIMARY KEY,title TEXT NOT NULL,filename TEXT NOT NULL,bytes INTEGER NOT NULL,duration INTEGER NOT NULL DEFAULT 0,position INTEGER NOT NULL DEFAULT 0,subtitle TEXT,subtitle_name TEXT,kind TEXT NOT NULL DEFAULT 'direct',manifest TEXT,audio TEXT,added_at INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE downloads(id TEXT PRIMARY KEY,title TEXT NOT NULL,url TEXT NOT NULL,status TEXT NOT NULL,bytes INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL DEFAULT 0,etag TEXT NOT NULL DEFAULT '',modified TEXT NOT NULL DEFAULT '',resumable INTEGER NOT NULL DEFAULT 0,error TEXT,source_request TEXT,audio TEXT,added_at INTEGER NOT NULL)")
    }
    override fun onUpgrade(db:SQLiteDatabase,oldVersion:Int,newVersion:Int){
        if(oldVersion<2){
            db.execSQL("ALTER TABLE downloads ADD COLUMN source_request TEXT")
            db.execSQL("ALTER TABLE videos ADD COLUMN kind TEXT NOT NULL DEFAULT 'direct'")
            db.execSQL("ALTER TABLE videos ADD COLUMN manifest TEXT")
        }
        if(oldVersion<3){
            db.execSQL("ALTER TABLE downloads ADD COLUMN audio TEXT")
            db.execSQL("ALTER TABLE videos ADD COLUMN audio TEXT")
        }
    }
    private fun id(value:String):String {require(value.matches(Regex("[a-f0-9-]{36}"))){"Invalid saved item."};return value}
    private fun file(name:String):File {require(name.length<150&&!name.contains('/')&&!name.contains('\\'));val result=File(directory,name).canonicalFile;require(result.parentFile==directory.canonicalFile);return result}
    fun partial(value:String)=file(id(value)+".part")
    fun thumbnail(value:String)=file(id(value)+".jpg")
    fun hlsDirectory(value:String):File {
        val base=File(directory,"hls").canonicalFile
        check(base.mkdirs()||base.isDirectory)
        return File(base,id(value)).canonicalFile.also{require(it.parentFile==base)}
    }
    fun hlsMetadata(value:String):JSONObject?=readableDatabase.rawQuery("SELECT manifest FROM videos WHERE id=? AND kind='hls'",arrayOf(id(value))).use{
        if(it.moveToFirst()&&!it.isNull(0))JSONObject(it.getString(0)) else null
    }
    private fun removeHls(value:String){
        val folder=hlsDirectory(value)
        check(!folder.exists()||folder.deleteRecursively()){"Could not remove saved streaming segments."}
    }
    fun video(value:String):File = readableDatabase.rawQuery("SELECT filename FROM videos WHERE id=?",arrayOf(id(value))).use{require(it.moveToFirst()){"Saved video not found."};file(it.getString(0))}
    fun subtitle(value:String):File?=readableDatabase.rawQuery("SELECT subtitle FROM videos WHERE id=?",arrayOf(id(value))).use{if(it.moveToFirst()&&!it.isNull(0))file(it.getString(0)) else null}
    fun videoTitle(value:String):String=readableDatabase.rawQuery("SELECT title FROM videos WHERE id=?",arrayOf(id(value))).use{require(it.moveToFirst());it.getString(0)}
    fun position(value:String):Long=readableDatabase.rawQuery("SELECT position FROM videos WHERE id=?",arrayOf(id(value))).use{if(it.moveToFirst())it.getLong(0) else 0}
    fun savePosition(value:String,position:Long,duration:Long){writableDatabase.execSQL("UPDATE videos SET position=?,duration=CASE WHEN ?>0 THEN ? ELSE duration END WHERE id=?",arrayOf<Any>(position.coerceAtLeast(0),duration,duration,id(value)))}
    fun list():JSONObject {
        val rows=JSONArray();var used=0L
        readableDatabase.rawQuery("SELECT * FROM videos ORDER BY added_at DESC",null).use{while(it.moveToNext()){val bytes=it.getLong(it.getColumnIndexOrThrow("bytes"));used+=bytes;rows.put(JSONObject().put("id",it.getString(it.getColumnIndexOrThrow("id"))).put("title",it.getString(it.getColumnIndexOrThrow("title"))).put("bytes",bytes).put("durationMs",it.getLong(it.getColumnIndexOrThrow("duration"))).put("positionMs",it.getLong(it.getColumnIndexOrThrow("position"))).put("subtitleName",nullable(it,"subtitle_name")).put("audio",nullable(it,"audio")).put("addedAt",it.getLong(it.getColumnIndexOrThrow("added_at"))))}}
        return JSONObject().put("items",rows).put("usedBytes",used).put("freeBytes",StatFs(directory.path).availableBytes)
    }
    private fun nullable(cursor:Cursor,column:String):Any=cursor.getColumnIndexOrThrow(column).let{if(cursor.isNull(it))JSONObject.NULL else cursor.getString(it)}
    private fun displayName(uri:Uri,operation:ImportOperation):String {
        operation.check()
        val name=context.contentResolver.query(uri,arrayOf(OpenableColumns.DISPLAY_NAME),null,null,null,operation.signal)?.use{operation.check();if(it.moveToFirst())it.getString(0) else null}?.take(200) ?: "Local episode"
        operation.progress();return name
    }
    fun importVideo(uri:Uri,operation:ImportOperation=ImportOperation()):JSONObject {
        require(uri.scheme=="content"){"Choose a video through Android's file picker."}
        var dest:File?=null
        try {
            val name=displayName(uri,operation)
            val knownExtension=name.substringAfterLast('.').lowercase() in listOf("mp4","mkv","webm","m4v","mov")
            require(knownExtension||(context.contentResolver.getType(uri) ?: "").startsWith("video/")){"Choose a video file."};operation.check()
            val value=UUID.randomUUID().toString();dest=partial(value)
            dest.outputStream().use{output->operation.copy(context.contentResolver,uri,output,TransferChecks.MAX_FILE_BYTES){require(StatFs(directory.path).availableBytes>64L*1024*1024){"Not enough free storage to save this episode."}}}
            require(dest.length()>0){"The selected video is empty."}
            val final=complete(value,name,dest,operation)
            return JSONObject().put("id",value).put("title",name).put("bytes",final.length())
        }catch(error:Exception){operation.cancel(error);dest?.delete();throw error}
    }
    fun importSubtitle(value:String,uri:Uri,operation:ImportOperation=ImportOperation()):JSONObject {
        var stage:File?=null
        try {
            video(value);require(uri.scheme=="content");val name=displayName(uri,operation)
            val data=java.io.ByteArrayOutputStream();operation.copy(context.contentResolver,uri,data,4L*1024*1024)
            val decoder=Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
            val text=SubtitleText.toVtt(decoder.decode(java.nio.ByteBuffer.wrap(data.toByteArray())).toString())
            stage=file(UUID.randomUUID().toString()+".vtt");stage.writeText(text,Charsets.UTF_8);val ready=stage
            return operation.commit{synchronized(this){video(value);val previous=subtitle(value);check(writableDatabase.update("videos",ContentValues().apply{put("subtitle",ready.name);put("subtitle_name",name)},"id=?",arrayOf(id(value)))==1);previous?.delete();JSONObject().put("subtitleName",name)}}
        }catch(error:Exception){operation.cancel(error);stage?.delete();throw error}
    }
    @Synchronized fun remove(value:String) {
        val video=video(value);val subtitle=subtitle(value)
        thumbnail(value).delete();if(hlsMetadata(value)!=null)removeHls(value);check(!video.exists()||video.delete()){"Could not remove saved video."};subtitle?.delete()
        writableDatabase.delete("videos","id=?",arrayOf(id(value)))
    }
    fun addDownload(url:String,title:String):String=addTransfer(url,title,null)
    @Synchronized fun addSourceDownload(request:SourceMediaRequest,title:String):String {
        readableDatabase.rawQuery("SELECT id FROM downloads WHERE url=? AND COALESCE(audio,'')=? AND status IN ('queued','running') LIMIT 1",arrayOf(request.url,request.audio ?: "")).use{
            if(it.moveToFirst())return it.getString(0)
        }
        return addTransfer(request.url,title,request.toJson(),request.audio)
    }
    private fun addTransfer(url:String,title:String,source:String?,audio:String?=null):String {
        val value=UUID.randomUUID().toString()
        writableDatabase.insertOrThrow("downloads",null,ContentValues().apply{
            put("id",value);put("title",title.take(200).ifBlank{"Saved episode"});put("url",url);put("status","queued")
            put("added_at",System.currentTimeMillis()/1000);if(source!=null)put("source_request",source);put("audio",audio)
        })
        return value
    }
    fun downloads():JSONArray=JSONArray().apply{readableDatabase.rawQuery("SELECT * FROM downloads ORDER BY added_at DESC",null).use{while(it.moveToNext())put(JSONObject().put("id",it.getString(it.getColumnIndexOrThrow("id"))).put("title",it.getString(it.getColumnIndexOrThrow("title"))).put("host",runCatching{Uri.parse(it.getString(it.getColumnIndexOrThrow("url"))).host}.getOrNull() ?: "").put("status",it.getString(it.getColumnIndexOrThrow("status"))).put("bytes",it.getLong(it.getColumnIndexOrThrow("bytes"))).put("totalBytes",it.getLong(it.getColumnIndexOrThrow("total"))).put("resumable",it.getInt(it.getColumnIndexOrThrow("resumable"))==1).put("error",nullable(it,"error")).put("audio",nullable(it,"audio")))}}
    fun isRunning(value:String):Boolean=readableDatabase.rawQuery("SELECT status FROM downloads WHERE id=?",arrayOf(id(value))).use{
        it.moveToFirst()&&it.getString(0)=="running"
    }
    fun download(value:String):DownloadRecord=readableDatabase.rawQuery("SELECT * FROM downloads WHERE id=?",arrayOf(id(value))).use{require(it.moveToFirst()){"Download not found."};DownloadRecord(value,it.getString(it.getColumnIndexOrThrow("title")),it.getString(it.getColumnIndexOrThrow("url")),it.getString(it.getColumnIndexOrThrow("status")),it.getLong(it.getColumnIndexOrThrow("bytes")),it.getLong(it.getColumnIndexOrThrow("total")),it.getString(it.getColumnIndexOrThrow("etag")),it.getString(it.getColumnIndexOrThrow("modified")),it.getInt(it.getColumnIndexOrThrow("resumable"))==1,it.getString(it.getColumnIndexOrThrow("source_request"))?.let(SourceMediaRequest::fromJson))}
    @Synchronized fun updateDownload(value:String,status:String,bytes:Long?=null,total:Long?=null,etag:String?=null,modified:String?=null,resumable:Boolean?=null,error:String?=null):Boolean {
        val prior=when(status){
            "running"->listOf("queued","running")
            "paused"->listOf("queued","running","paused")
            "queued"->listOf("paused","failed","queued")
            "cancelled"->listOf("queued","running","paused","failed","cancelled")
            "complete"->listOf("running","complete")
            "failed"->listOf("running","failed")
            else->throw IllegalArgumentException("Invalid download state.")
        }
        val values=ContentValues().apply{put("status",status);bytes?.let{put("bytes",it)};total?.let{put("total",it)};etag?.let{put("etag",it)};modified?.let{put("modified",it)};resumable?.let{put("resumable",if(it)1 else 0)};if(error==null)putNull("error") else put("error",error.take(300));if(status=="complete")putNull("source_request")}
        return writableDatabase.update("downloads",values,"id=? AND status IN ("+prior.joinToString(","){"?"}+")",arrayOf(id(value),*prior.toTypedArray()))>0
    }
    @Synchronized internal fun failUnreadableQueuedDownload(value:String):Boolean=
        writableDatabase.update("downloads",ContentValues().apply{
            put("status","failed")
            put("error","The saved download could not be read. Reopen the episode and download it again.")
        },"id=? AND status='queued'",arrayOf(id(value)))==1
    fun queued():String?=readableDatabase.rawQuery("SELECT id FROM downloads WHERE status='queued' ORDER BY added_at,rowid LIMIT 1",null).use{if(it.moveToFirst())it.getString(0) else null}
    fun pauseInterrupted(){writableDatabase.execSQL("UPDATE downloads SET status='paused' WHERE status IN ('running','queued')")}
    fun recoverStorage(){
        writableDatabase.delete("downloads","status='cancelled'",null)
        val known=mutableSetOf<String>()
        readableDatabase.rawQuery("SELECT id,filename,subtitle FROM videos",null).use{while(it.moveToNext()){known.add(it.getString(1));known.add(it.getString(0)+".jpg");if(!it.isNull(2))known.add(it.getString(2))}}
        readableDatabase.rawQuery("SELECT id FROM downloads",null).use{while(it.moveToNext())known.add(it.getString(0)+".part")}
        val knownHls=mutableSetOf<String>()
        readableDatabase.rawQuery("SELECT id FROM videos WHERE kind='hls'",null).use{while(it.moveToNext())knownHls.add(it.getString(0))}
        // Recovery needs ownership, not credentials or URI validation. Keep any
        // cache owned by a transfer; parse its private request only when transferring.
        readableDatabase.rawQuery("SELECT id FROM downloads",null).use{
            while(it.moveToNext())knownHls.add(it.getString(0))
        }
        val hls=File(directory,"hls").canonicalFile
        for(item in hls.listFiles() ?: emptyArray())if(item.isDirectory&&item.name.matches(Regex("[a-f0-9-]{36}"))&&item.canonicalFile.parentFile==hls&&item.name !in knownHls)item.deleteRecursively()
        for(item in directory.listFiles() ?: emptyArray())if(item.name.matches(Regex("[a-f0-9-]{36}\\.(part|video|jpg|srt|vtt)"))&&item.name !in known&&item.canonicalFile.parentFile==directory.canonicalFile)item.delete()
    }
    fun deleteDownload(value:String){
        partial(value).delete()
        val saved=readableDatabase.rawQuery("SELECT 1 FROM videos WHERE id=?",arrayOf(id(value))).use{it.moveToFirst()}
        if(!saved)removeHls(value)
        writableDatabase.delete("downloads","id=?",arrayOf(id(value)))
    }
    fun completeHls(value:String,title:String,bytes:Long,manifest:JSONObject) {
        require(bytes>0&&bytes<=TransferChecks.MAX_FILE_BYTES)
        val marker=partial(value);val final=file(id(value)+".video");var committed=false
        try{
            marker.writeText("AniVerse offline HLS v1\n")
            synchronized(this){
                val record=download(value)
                check(record.status=="running"){"Download state changed before completion."}
                check(marker.renameTo(final)){"Could not finalize this saved episode."}
                val db=writableDatabase;db.beginTransaction()
                try{
                    db.insertOrThrow("videos",null,ContentValues().apply{
                        put("id",value);put("title",title.take(200));put("filename",final.name);put("bytes",bytes)
                        put("kind","hls");put("manifest",manifest.toString());put("audio",record.request?.audio);put("added_at",System.currentTimeMillis()/1000)
                    })
                    check(updateDownload(value,"complete",bytes=bytes,total=bytes,resumable=true))
                    db.setTransactionSuccessful()
                }finally{db.endTransaction()}
                committed=true
            }
        }finally{marker.delete();if(!committed)final.delete()}
    }
    fun complete(value:String,title:String,part:File,operation:ImportOperation?=null):File {
        require(part.canonicalFile==partial(value).canonicalFile&&part.length()>0)
        val final=file(id(value)+".video");val stagedThumb=file(UUID.randomUUID().toString()+".jpg");var committed=false
        try {
            // Parsing stays outside the store/publication lock; cancellation can reject late output.
            val duration=MediaMetadataRetriever().let{retriever->try{retriever.setDataSource(part.path);require((retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0)>0){"This file is not a video supported by this device."};runCatching{retriever.getScaledFrameAtTime(1_000_000,MediaMetadataRetriever.OPTION_CLOSEST_SYNC,512,288)?.let{bitmap->stagedThumb.outputStream().use{bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG,80,it)};bitmap.recycle()}};retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0}finally{retriever.release()}}
            operation?.check()
            val publish={synchronized(this){
                val downloadStatus=readableDatabase.rawQuery("SELECT status FROM downloads WHERE id=?",arrayOf(value)).use{if(it.moveToFirst())it.getString(0) else null}
                check(downloadStatus==null||downloadStatus=="running"){"Download state changed before completion."}
                check(part.renameTo(final)){"Could not finish the saved file."}
                if(stagedThumb.exists())check(stagedThumb.renameTo(thumbnail(value))){"Could not finish the video thumbnail."}
                val db=writableDatabase;db.beginTransaction()
                try{db.execSQL("INSERT OR REPLACE INTO videos(id,title,filename,bytes,duration,position,added_at,audio) VALUES(?,?,?,?,?,0,?,(SELECT audio FROM downloads WHERE id=?))",arrayOf(id(value),title.take(200),final.name,final.length(),duration,System.currentTimeMillis()/1000,id(value)));if(downloadStatus!=null)check(updateDownload(value,"complete",bytes=final.length(),total=final.length()));db.setTransactionSuccessful()}finally{db.endTransaction()}
                committed=true;final
            }}
            return if(operation==null)publish() else operation.commit(publish)
        }finally{stagedThumb.delete();if(!committed){final.delete();thumbnail(value).delete()}}
    }
}
