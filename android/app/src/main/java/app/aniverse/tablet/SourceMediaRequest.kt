package app.aniverse.tablet

import java.net.URI
import org.json.JSONObject
import org.json.JSONArray

/** Native-only source context. URLs, cookies and headers never cross the renderer bridge. */
data class SourceMediaRequest(
    val url:String,
    val referer:String,
    val userAgent:String,
    val cookie:String?=null,
    val kind:String="direct",
    val originHeader:String?=null,
    val audio:String?=null,
    val extraHeaders:Map<String,String> = emptyMap(),
    val relatedContexts:List<SourceMediaRequest> = emptyList()
) {
    init {
        ObservedMediaHeaders.validate(extraHeaders)
        require(kind in setOf("direct","hls"))
        require(audio==null||audio in setOf("sub","dub")){"Invalid source audio selection."}
        for((value,limit) in listOf(url to 8192,referer to 8192,userAgent to 1024,(cookie ?: "") to 16384,(originHeader ?: "") to 2048))
            require(value.length<=limit&&value.none{it.code<32||it.code==127}){"Source context exceeds its safe header budget."}
        require(originHeader==null||validHeaderOrigin(originHeader)){"The source Origin header is invalid."}
        require(origin(url)!=null&&(referer.isBlank()||origin(referer)!=null)){"Source media context needs an HTTP(S) address."}
        require(relatedContexts.size<=16&&relatedContexts.all{it.relatedContexts.isEmpty()}){"Source media contexts exceed their flat-list budget."}
        val contexts=listOf(this)+relatedContexts
        require(contexts.sumOf{it.contextCost()}<=MAX_CONTEXT_BYTES){"Source media contexts exceed their private storage budget."}
        for(group in contexts.groupBy{origin(it.url)}.values){
            require(group.map{it.ownHeaders()}.distinct().size==1){"Observed source contexts conflict for one origin."}
        }
    }
    private fun ownHeaders():Map<String,String> = buildMap{
        put("User-Agent",userAgent.ifBlank{"AniVerse-Android/"+BuildConfig.VERSION_NAME})
        putAll(extraHeaders)
        if(referer.isNotBlank())put("Referer",referer)
        originHeader?.let{put("Origin",it)}
        cookie?.takeIf{it.isNotBlank()}?.let{put("Cookie",it)}
    }
    fun headersFor(target:String):Map<String,String>{
        val destination=origin(target)
        val context=(listOf(this)+relatedContexts).firstOrNull{origin(it.url)==destination}
        // Each destination needs its own observed context; redirects never inherit another origin's credentials.
        return context?.ownHeaders() ?: mapOf("User-Agent" to userAgent.ifBlank{"AniVerse-Android/"+BuildConfig.VERSION_NAME})
    }
    private fun contextCost():Int{
        fun encoded(value:String)=value.toByteArray(Charsets.UTF_8).size+value.count{it=='"'||it=='\\'}
        return 512+listOf(url,referer,userAgent,cookie ?: "",originHeader ?: "",kind,audio ?: "").sumOf(::encoded)+
            extraHeaders.entries.sumOf{encoded(it.key)+encoded(it.value)}
    }
    private fun jsonObject():JSONObject=JSONObject().put("url",url).put("referer",referer).put("userAgent",userAgent)
        .put("cookie",cookie ?: JSONObject.NULL).put("kind",kind).put("originHeader",originHeader ?: JSONObject.NULL)
        .put("audio",audio ?: JSONObject.NULL).put("extraHeaders",JSONObject(extraHeaders))
        .put("relatedContexts",JSONArray().apply{relatedContexts.forEach{put(it.jsonObject())}})
    fun toJson():String=jsonObject().toString().also{
        require(it.toByteArray(Charsets.UTF_8).size<=MAX_CONTEXT_BYTES){"Source media contexts exceed their private storage budget."}
    }
    override fun toString()="SourceMediaRequest(kind=$kind, context=private)"
    companion object {
        private const val MAX_CONTEXT_BYTES=128*1024
        fun fromJson(value:String):SourceMediaRequest {
            require(value.length<=MAX_CONTEXT_BYTES&&value.toByteArray(Charsets.UTF_8).size<=MAX_CONTEXT_BYTES){"The saved source context exceeds its budget."}
            return parse(JSONObject(value),true)
        }
        private fun parse(json:JSONObject,allowRelated:Boolean):SourceMediaRequest{
            val headers=if(!json.has("extraHeaders")||json.isNull("extraHeaders"))emptyMap() else{
                val stored=json.getJSONObject("extraHeaders")
                require(stored.length()<=24){"The saved source headers exceed their budget."}
                stored.keys().asSequence().associateWith{key->
                    val item=stored.get(key);require(item is String){"Invalid saved source headers."};item
                }
            }
            val list=if(!json.has("relatedContexts")||json.isNull("relatedContexts"))JSONArray() else json.getJSONArray("relatedContexts")
            require(list.length()<=16&&(allowRelated||list.length()==0)){"Invalid nested source contexts."}
            val related=(0 until list.length()).map{parse(list.getJSONObject(it),false)}
            return SourceMediaRequest(json.getString("url"),json.getString("referer"),json.getString("userAgent"),
                if(json.isNull("cookie"))null else json.getString("cookie"),json.getString("kind"),
                if(!json.has("originHeader")||json.isNull("originHeader"))null else json.getString("originHeader"),
                if(!json.has("audio")||json.isNull("audio"))null else json.getString("audio"),headers,related)
        }
        private fun validHeaderOrigin(value:String):Boolean=value=="null"||runCatching {
            val uri=URI(value)
            uri.scheme in setOf("http","https")&&!uri.host.isNullOrBlank()&&uri.rawUserInfo==null&&
                (uri.port==-1||uri.port in 1..65535)&&uri.rawPath.isNullOrEmpty()&&uri.rawQuery==null&&uri.rawFragment==null
        }.getOrDefault(false)
        private fun origin(value:String):String?=runCatching {
            val uri=URI(value);require(uri.scheme in setOf("http","https")&&uri.host!=null&&uri.rawUserInfo==null)
            uri.scheme+"://"+uri.host.lowercase()+":"+if(uri.port!=-1)uri.port else if(uri.scheme=="https")443 else 80
        }.getOrNull()
    }
}
