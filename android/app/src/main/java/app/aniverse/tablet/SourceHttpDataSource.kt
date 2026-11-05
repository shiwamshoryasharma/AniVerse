package app.aniverse.tablet

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSpec
import java.io.BufferedInputStream
import java.io.ByteArrayInputStream
import java.io.EOFException
import java.io.InputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

/** Guarded input for all HLS manifests/keys/segments, retaining exact-origin context only. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
internal class SourceHttpDataSource(
    private val request:SourceMediaRequest,
    private val policy:NetworkPolicy,
    private val storage:TransferStorageChecks,
    private val active:()->Boolean,
    private val manifests:MutableSet<String>,
    private val budget:SourceTransferBudget,
    private val observe:(HttpURLConnection?)->Unit
):BaseDataSource(true){
    private var connection:HttpURLConnection?=null
    private var input:InputStream?=null
    private var opened=false
    private var uri:Uri?=null
    private var remaining=-1L
    private var inputIsMemory=false
    private fun checkActive(){if(!active()||Thread.currentThread().isInterrupted)throw java.io.InterruptedIOException("Source download stopped.")}
    private fun consumed(count:Int){
        checkActive();budget.read(count)
        storage.onRead(count)
    }
    private fun connect(url:String,position:Long,length:Long):HttpURLConnection{
        var target=url
        repeat(6){
            checkActive();budget.request()
            require(policy.allow(target)){"A source segment address is blocked by source protection."}
            val current=URL(target).openConnection() as HttpURLConnection
            connection=current;observe(current)
            current.instanceFollowRedirects=false;current.connectTimeout=15000;current.readTimeout=15000
            current.setRequestProperty("Accept-Encoding","identity")
            for((name,value)in request.headersFor(target))current.setRequestProperty(name,value)
            if(position>0||length!=-1L)current.setRequestProperty("Range","bytes="+position+"-"+if(length==-1L)"" else (position+length-1))
            val status=current.responseCode
            if(status in setOf(301,302,303,307,308)){
                val location=current.getHeaderField("Location");current.disconnect()
                require(!location.isNullOrBlank()){"The source sent an invalid redirect."}
                target=URI(target).resolve(location).toString()
            }else{
                require(status==200||status==206){"Source media server returned HTTP $status."}
                return current
            }
        }
        error("Too many source-media redirects.")
    }
    private fun knownManifest(value:String)=value in manifests||runCatching{URI(value).path.lowercase().endsWith(".m3u8")}.getOrDefault(false)
    override fun open(dataSpec:DataSpec):Long{
        transferInitializing(dataSpec)
        try{
            checkActive()
            var fetchPosition=if(knownManifest(dataSpec.uri.toString()))0L else dataSpec.position
            var current=connect(dataSpec.uri.toString(),fetchPosition,if(fetchPosition!=dataSpec.position)-1 else dataSpec.length)
            var plan=SourceRanges.validate(current.responseCode,current.getHeaderField("Content-Range"),current.contentLengthLong,fetchPosition,
                if(fetchPosition!=dataSpec.position)-1 else dataSpec.length)
            var stream=BufferedInputStream(current.inputStream,8192)
            stream.mark(512);val prefix=stream.readNBytes(512);stream.reset()
            val sniff=String(prefix,Charsets.UTF_8).removePrefix("\uFEFF").trimStart().startsWith("#EXTM3U")
            val mime=current.contentType?.substringBefore(';')?.lowercase() ?: ""
            val playlist=knownManifest(dataSpec.uri.toString())||knownManifest(current.url.toString())||mime.contains("mpegurl")||sniff
            uri=Uri.parse(current.url.toString())
            if(playlist){
                if(fetchPosition>0){
                    stream.close();current.disconnect();fetchPosition=0
                    current=connect(dataSpec.uri.toString(),0,-1)
                    plan=SourceRanges.validate(current.responseCode,current.getHeaderField("Content-Range"),current.contentLengthLong,0,-1)
                    stream=BufferedInputStream(current.inputStream,8192);uri=Uri.parse(current.url.toString())
                }
                require(plan.length<=HlsChecks.MAX_PLAYLIST_BYTES){"The source playlist is too large."}
                val bytes=stream.use{
                    val output=java.io.ByteArrayOutputStream();val buffer=ByteArray(8192)
                    while(true){
                        checkActive();val count=it.read(buffer);if(count<0)break
                        consumed(count);require(output.size()+count<=HlsChecks.MAX_PLAYLIST_BYTES){"The source playlist is too large."}
                        output.write(buffer,0,count)
                    }
                    if(plan.length>=0)require(output.size().toLong()==plan.length){"The source playlist ended early."}
                    output.toByteArray()
                }
                HlsChecks.validate(bytes)
                manifests.add(dataSpec.uri.toString());manifests.add(current.url.toString())
                manifests.addAll(HlsChecks.playlistUris(bytes,current.url.toString()))
                require(dataSpec.position<=bytes.size){"Invalid cached playlist offset."}
                val available=bytes.size-dataSpec.position.toInt()
                remaining=if(dataSpec.length<0)available.toLong() else minOf(available.toLong(),dataSpec.length)
                input=ByteArrayInputStream(bytes,dataSpec.position.toInt(),remaining.toInt());inputIsMemory=true
            }else{
                var skip=plan.skip
                val buffer=ByteArray(8192)
                while(skip>0){
                    checkActive();val count=stream.read(buffer,0,minOf(skip,buffer.size.toLong()).toInt())
                    if(count<0)throw EOFException("The source ended before its saved offset.")
                    consumed(count);skip-=count
                }
                input=stream;remaining=plan.length;inputIsMemory=false
            }
            opened=true;transferStarted(dataSpec);return remaining
        }catch(error:Exception){
            close();throw if(error is IOException)error else IOException(error.message ?: "Source media request failed.",error)
        }
    }
    override fun read(buffer:ByteArray,offset:Int,length:Int):Int{
        checkActive()
        if(length==0)return 0
        if(remaining==0L)return C.RESULT_END_OF_INPUT
        val wanted=if(remaining<0)length else minOf(length.toLong(),remaining).toInt()
        val count=input!!.read(buffer,offset,wanted)
        if(count<0){if(remaining>0)throw EOFException("The source segment ended early.");return C.RESULT_END_OF_INPUT}
        if(!inputIsMemory)consumed(count)
        if(remaining>=0)remaining-=count
        bytesTransferred(count);return count
    }
    override fun getUri():Uri?=uri
    override fun close(){
        try{input?.close()}finally{
            input=null;connection?.disconnect();connection=null;observe(null);uri=null
            if(opened){opened=false;transferEnded()}
        }
    }
}
