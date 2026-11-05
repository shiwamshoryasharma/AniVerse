package app.aniverse.tablet

import java.net.URI
import java.util.Locale

/** Pure navigation decisions shared by browser code and native regression tests. */
internal object SourceNavigation {
    fun sameSource(expected:String,value:String):Boolean = runCatching {
        val source=URI(expected)
        val target=URI(value)
        fun host(uri:URI)=uri.host?.lowercase(Locale.ROOT)?.removePrefix("www.")
        fun port(uri:URI)=if(uri.port!=-1)uri.port else if(uri.scheme.equals("https",true))443 else 80
        source.rawUserInfo==null && target.rawUserInfo==null && host(source)!=null &&
            source.scheme.equals(target.scheme,true) && host(source)==host(target) && port(source)==port(target)
    }.getOrDefault(false)

    fun queries(titles:List<String>,fallback:String):List<String> =
        (titles+fallback).map { it.trim() }.filter { it.isNotEmpty()&&it!="null"&&it.length<=200 }
            .distinctBy { it.lowercase(Locale.ROOT) }.take(6)
}
