package app.aniverse.tablet

import android.content.Context
import org.json.JSONObject
import java.net.URI
import java.util.zip.GZIPInputStream

/** Immutable host lookup; exceptions win unless the matched block is important. */
internal class AdDomains(lines:Sequence<String>) {
    private val blocked=HashSet<String>()
    private val allowed=HashSet<String>()
    private val important=HashSet<String>()
    init {for(line in lines)if(line.length in 4..255)when(line[0]) {'+'->blocked.add(line.substring(1));'-'->allowed.add(line.substring(1));'!'->important.add(line.substring(1))}}
    fun blocks(url:String):Boolean {
        var host=try {val uri=URI(url);if(uri.scheme!="https"&&uri.scheme!="http")return false;uri.host?.lowercase()?.trimEnd('.') ?: return false}catch(_:Exception){return false}
        var deny=false;var exception=false
        while(host.isNotEmpty()) {
            if(host in important)return true
            if(host in allowed)exception=true
            if(host in blocked)deny=true
            val dot=host.indexOf('.');if(dot<0)break;host=host.substring(dot+1)
        }
        return deny&&!exception
    }
}

/** Packaged rules only: source pages cannot install filters or request privileged actions. */
internal class AdFilter(context:Context) {
    private val domains by lazy { context.assets.open("ad-domains.bin").use { input->GZIPInputStream(input).bufferedReader().use { AdDomains(it.lineSequence()) } } }
    fun blocks(url:String)=domains.blocks(url)
    val script:String=context.assets.open("ad-cosmetics.css").bufferedReader().use { reader->
        val css=JSONObject.quote(reader.readText())
        """(()=>{if(window.__aniverseAdCosmetics)return;window.__aniverseAdCosmetics=true;
        const apply=()=>{try{const sheet=new CSSStyleSheet();sheet.replaceSync($css);document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];}catch{}};
        apply();document.addEventListener('DOMContentLoaded',apply,{once:true});})();""".trimIndent()
    }
}
