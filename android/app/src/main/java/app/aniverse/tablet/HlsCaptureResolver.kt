package app.aniverse.tablet

import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import android.os.SystemClock

/** Correlates one observed HLS master/variant/audio tree, never arbitrary first/last candidates. */
internal object HlsCaptureGraph {
    fun canonical(value:String):String=URI(value.substringBefore('#')).normalize().toString()
    fun links(text:String,base:String):Set<String> {
        val lines=text.lineSequence().map{it.trim()}.toList();val found=linkedSetOf<String>()
        fun add(value:String){runCatching{URI(base).resolve(value)}.getOrNull()?.takeIf{it.scheme in setOf("http","https")&&it.host!=null&&it.rawUserInfo==null}?.let{found.add(canonical(it.toString()))}}
        var variant=false
        for(line in lines){
            if(line.startsWith("#EXT-X-STREAM-INF:")){variant=true;continue}
            if(line.startsWith("#EXT-X-MEDIA:"))Regex("(?:^|,)URI=\"([^\"]+)\"").find(line.substringAfter(':'))?.groupValues?.get(1)?.let(::add)
            if(line.isNotBlank()&&!line.startsWith('#')){if(variant)add(line);variant=false}
        }
        return found
    }
    fun choose(candidates:List<String>,edges:Map<String,Set<String>>):String {
        val urls=candidates.map(::canonical).distinct()
        require(urls.isNotEmpty()&&urls.size<=16){"The player has too many active media candidates."}
        fun covers(root:String):Boolean {
            val seen=mutableSetOf<String>();val pending=java.util.ArrayDeque<String>();pending.add(root)
            while(pending.isNotEmpty()&&seen.size<=256){val item=pending.removeFirst();if(seen.add(item))for(next in edges[item].orEmpty())if(next in urls)pending.add(next)}
            return urls.all{it in seen}
        }
        val roots=urls.filter(::covers)
        check(roots.size==1){"Several unrelated streams are active. Select the episode player and retry Download."}
        return candidates.first{canonical(it)==roots.single()}
    }
}

/** Bounded IO probe of already-observed manifests. Native headers remain origin-bound. */
internal object HlsCaptureResolver {
    fun resolve(candidates:List<SourceMediaRequest>,policy:NetworkPolicy,adBlocked:(String)->Boolean={false}):SourceMediaRequest {
        require(candidates.all{it.relatedContexts.isEmpty()}){"Source media context must come from current native observations."}
        val unique=candidates.distinctBy{HlsCaptureGraph.canonical(it.url)}
        require(unique.isNotEmpty()&&unique.size<=16){"The active stream cannot be identified safely."}
        if(unique.size==1)return unique.single()
        require(unique.all{it.kind=="hls"}){"Multiple unrelated media players are active."}
        val deadline=SystemClock.elapsedRealtime()+8000;var remaining=HlsChecks.MAX_PLAYLIST_BYTES
        val graph=linkedMapOf<String,Set<String>>()
        fun checkTime(){check(SystemClock.elapsedRealtime()<deadline){"Source media selection timed out. Keep the episode playing and retry."}}
        fun remainingTimeout():Int{
            checkTime()
            return (deadline-SystemClock.elapsedRealtime()).coerceIn(1,8000).toInt()
        }
        for(request in unique){
            checkTime();var target=request.url;var complete=false
            repeat(6){
                if(complete)return@repeat
                checkTime();require(!adBlocked(target)&&policy.allow(target)){"The source manifest address is blocked."};checkTime()
                val timeout=remainingTimeout()
                val connection=URL(target).openConnection() as HttpURLConnection
                try {
                    connection.instanceFollowRedirects=false;connection.connectTimeout=timeout;connection.readTimeout=timeout
                    connection.setRequestProperty("Accept-Encoding","identity")
                    for((name,value)in request.headersFor(target))connection.setRequestProperty(name,value)
                    val status=connection.responseCode;checkTime()
                    if(status in setOf(301,302,303,307,308)){
                        val location=connection.getHeaderField("Location");require(!location.isNullOrBlank()){"Invalid source redirect."}
                        target=URI(target).resolve(location).toString()
                    }else{
                        require(status==200){"Source manifest returned HTTP $status."}
                        require(connection.contentLengthLong<=remaining){"Source manifests exceed the selection budget."}
                        val bytes=connection.inputStream.use{input->
                            val output=java.io.ByteArrayOutputStream();val buffer=ByteArray(8192)
                            while(true){
                                connection.readTimeout=remainingTimeout()
                                val size=input.read(buffer);checkTime()
                                if(size<0)break
                                remaining-=size;require(remaining>=0){"Source manifests exceed the selection budget."}
                                output.write(buffer,0,size)
                            }
                            output.toByteArray()
                        }
                        HlsChecks.validate(bytes)
                        val base=HlsCaptureGraph.canonical(request.url)
                        graph[base]=HlsCaptureGraph.links(bytes.toString(Charsets.UTF_8),target)
                        complete=true
                    }
                }finally{connection.disconnect()}
            }
            check(complete){"Too many source manifest redirects."}
        }
        checkTime()
        val selected=HlsCaptureGraph.choose(unique.map{it.url},graph)
        val root=unique.first{it.url==selected}
        // Only the verified observed tree can retain independent CDN contexts.
        // Each companion still supplies credentials solely to its own captured origin.
        checkTime()
        return root.copy(relatedContexts=unique.filter{it!==root})
    }
}
