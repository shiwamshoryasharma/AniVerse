package app.aniverse.tablet

import java.net.URI
import java.util.Locale

/** Only replay headers actually seen on the owned player's native request; never manufacture browser state. */
internal object ObservedMediaHeaders {
    const val MAX_HEADERS=24
    const val MAX_VALUE=4096
    const val MAX_TOTAL=16384
    private val names=Regex("[a-z0-9_-]+")
    private val standard=setOf("accept","accept-language","authorization")
    private fun permitted(name:String)=name in standard||
        (name.startsWith("x-")&&name.length>2)
    fun sanitize(input:Map<String,String>):Map<String,String> {
        val result=linkedMapOf<String,String>()
        val conflicted=mutableSetOf<String>()
        var total=0
        for((key,value) in input){
            val name=key.lowercase(Locale.ROOT)
            if(name.length>64||!names.matches(name)||!permitted(name)||name in conflicted)continue
            if(value.length>MAX_VALUE||value.any{it.code<32||it.code==127})continue
            val prior=result[name]
            if(prior!=null){
                if(prior!=value){total-=name.length+prior.toByteArray(Charsets.UTF_8).size;result.remove(name);conflicted.add(name)}
                continue
            }
            val size=name.length+value.toByteArray(Charsets.UTF_8).size
            if(result.size>=MAX_HEADERS||total+size>MAX_TOTAL)continue
            result[name]=value;total+=size
        }
        return result.toMap()
    }
    fun requireSafe(input:Map<String,String>):Map<String,String> {
        val safe=sanitize(input)
        require(safe==input){"Observed source headers exceed their permitted context."}
        return safe
    }
    fun validate(input:Map<String,String>){requireSafe(input)}
}

/** Native observations only. No media URL, request context, or cookie crosses the app bridge. */
internal class PlaybackMediaCapture {
    data class Frame(
        val id:String,val frameUrl:String,val src:String,val resources:List<String>,
        val position:Double,val duration:Double,val width:Int,val height:Int,
        val ready:Int,val played:Boolean,val visible:Boolean,val encrypted:Boolean
    )
    data class Resolution(val url:String,val referer:String,val userAgent:String,val kind:String,val origin:String?=null,val extraHeaders:Map<String,String> = emptyMap())
    private data class Request(val url:String,val referer:String,val userAgent:String,val origin:String?,val extraHeaders:Map<String,String>)
    private var epoch=0
    private val requests=object:LinkedHashMap<String,Request>(128,.75f,true){
        override fun removeEldestEntry(entry:MutableMap.MutableEntry<String,Request>)=size>512
    }
    private val mediaRequests=object:LinkedHashMap<String,Request>(16,.75f,true){
        override fun removeEldestEntry(entry:MutableMap.MutableEntry<String,Request>)=size>64
    }
    private val manifests=object:LinkedHashMap<String,Request>(16,.75f,true){
        override fun removeEldestEntry(entry:MutableMap.MutableEntry<String,Request>)=size>64
    }

    @Synchronized fun reset(generation:Int){epoch=generation;requests.clear();mediaRequests.clear();manifests.clear()}
    @Synchronized fun observe(url:String,headers:Map<String,String>,generation:Int){
        if(generation!=epoch||!valid(url))return
        fun header(name:String)=headers.entries.firstOrNull{it.key.equals(name,true)}?.value?.take(8192)?.takeIf{it.none{c->c=='\r'||c=='\n'}} ?: ""
        val record=Request(url,header("Referer"),header("User-Agent"),originHeader(header("Origin")),ObservedMediaHeaders.sanitize(headers))
        requests[url]=record
        val path=runCatching{URI(url).path.orEmpty().lowercase(Locale.ROOT)}.getOrDefault("")
        if(header("Sec-Fetch-Dest").equals("video",true)||listOf(".mp4",".webm",".m4v",".mkv",".mov").any{path.endsWith(it)}||
            header("Range").startsWith("bytes="))mediaRequests[url]=record
        if(hls(url))manifests[url]=record
    }
    @Synchronized fun plan(frames:List<Frame>,generation:Int):List<Resolution> {
        check(generation==epoch){"The episode changed. Start playback again before downloading."}
        val active=frames.filter{it.visible&&it.played&&it.ready>=2&&it.width>=64&&it.height>=36&&
            it.position.isFinite()&&it.position>=0}
        check(active.size==1){"Play the episode in the selected player before downloading. Multiple active players cannot be resolved safely."}
        val frame=active.single()
        check(frame.duration.isFinite()&&frame.duration>0){"Live streams without a complete duration cannot be saved as offline episodes."}
        check(!frame.encrypted){"Protected playback cannot be saved. DRM downloads are not supported."}
        check(valid(frame.frameUrl)){"The active player context is unavailable."}
        fun matching(url:String):Request? {
            val value=requests[url] ?: mediaRequests[url] ?: manifests[url] ?: return null
            if(value.referer.isNotBlank()&&origin(value.referer)!=origin(frame.frameUrl))return null
            return value
        }
        val direct=if(valid(frame.src))matching(frame.src) else null
        val candidates=frame.resources.take(16).distinct().mapNotNull(::matching).filter{hls(it.url)}
        val eligible=direct?.let{listOf(it)} ?: candidates
        check(eligible.isNotEmpty()){"This player has not exposed a supported downloadable video. Keep the episode playing and retry."}
        return eligible.map { request->
            check(!URI(request.url).path.orEmpty().lowercase(Locale.ROOT).endsWith(".mpd")){"DASH downloads are not supported for this player."}
            Resolution(request.url,request.referer,request.userAgent,if(hls(request.url))"hls" else "direct",request.origin,request.extraHeaders)
        }
    }
    fun resolve(frames:List<Frame>,generation:Int):Resolution {
        val choices=plan(frames,generation)
        check(choices.size==1){"Multiple playlists require a verified master/variant relationship."}
        return choices.single()
    }
    /** A navigation cannot publish an older pending resolution into the download queue. */
    @Synchronized fun <T> commit(generation:Int,work:()->T):T {
        check(generation==epoch){"The episode changed before the download was queued."}
        return work()
    }
    companion object {
        private fun originHeader(value:String):String? {
            if(value=="null")return value
            return runCatching{
                val uri=URI(value)
                value.takeIf{uri.scheme in setOf("http","https")&&uri.host!=null&&uri.host.length<=253&&
                    uri.rawUserInfo==null&&uri.rawPath.isNullOrEmpty()&&uri.rawQuery==null&&uri.rawFragment==null&&
                    (uri.port==-1||uri.port in 1..65535)}
            }.getOrNull()
        }
        private fun valid(value:String):Boolean=runCatching{
            if(value.length>8192||value.any{it.code<32})return false
            val u=URI(value)
            (u.scheme=="https"||u.scheme=="http")&&u.host!=null&&u.rawUserInfo==null
        }.getOrDefault(false)
        private fun hls(value:String)=runCatching{URI(value).path.orEmpty().lowercase(Locale.ROOT).endsWith(".m3u8")}.getOrDefault(false)
        private fun origin(value:String):String?=runCatching{
            val u=URI(value)
            u.scheme.lowercase(Locale.ROOT)+"://"+u.host.lowercase(Locale.ROOT)+":"+(if(u.port!=-1)u.port else if(u.scheme=="https")443 else 80)
        }.getOrNull()
    }
}
