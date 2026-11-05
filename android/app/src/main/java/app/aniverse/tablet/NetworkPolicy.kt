package app.aniverse.tablet

import java.net.InetAddress
import java.net.URI
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Metadata-only network guard; original website/media requests remain WebView-owned. */
class NetworkPolicy(
    private val debugOrigin:String="",
    private val resolve:(String)->Array<InetAddress> = InetAddress::getAllByName,
    private val dns:java.util.concurrent.ExecutorService = ThreadPoolExecutor(2,4,30,TimeUnit.SECONDS,ArrayBlockingQueue(32),ThreadPoolExecutor.AbortPolicy()),
    private val dnsTimeoutMillis:Long=3000,
    private val additionalDebugOrigin:String=""
) {
    private val cache = object : LinkedHashMap<String, Pair<Long,Boolean>>(128,.75f,true) { override fun removeEldestEntry(entry: MutableMap.MutableEntry<String,Pair<Long,Boolean>>) = size > 256 }
    private val inFlight=HashMap<String,java.util.concurrent.Future<Boolean>>()
    private fun allowedDebugOrigin(uri:URI)=debugOrigin.isNotEmpty()&&
        (origin(uri)==debugOrigin||(additionalDebugOrigin.isNotEmpty()&&origin(uri)==additionalDebugOrigin))
    fun validUrl(value: String): URI? = try {
        require(value.length <= 8192 && value.none { it.code < 32 })
        val uri=URI(value); val host=uri.host ?: error("Missing host")
        require(uri.rawUserInfo == null && host.isNotBlank() && host.length <= 253 && (uri.port == -1 || uri.port in 1..65535))
        require(uri.scheme == "https" || (uri.scheme == "http" && allowedDebugOrigin(uri)))
        require(host.lowercase() != "appassets.androidplatform.net" && !host.lowercase().endsWith(".androidplatform.net"))
        uri
    } catch (_: Exception) { null }
    fun allow(value: String): Boolean {
        val uri=validUrl(value) ?: return false
        if(allowedDebugOrigin(uri)) return true
        val host=uri.host.removePrefix("[").removeSuffix("]").lowercase()
        val lookup=synchronized(cache) {
            cache[host]?.let { if(System.currentTimeMillis()-it.first<60000)return it.second }
            // A cold page can request many resources from one host at once. Share the
            // decision instead of filling the bounded resolver queue with duplicates.
            inFlight[host] ?: try {
                dns.submit<Boolean> {
                    val addresses=resolve(host)
                    addresses.isNotEmpty()&&addresses.all(::publicAddress)
                }.also{inFlight[host]=it}
            } catch(_:java.util.concurrent.RejectedExecutionException) {return false}
        }
        return try {
            val allowed=lookup.get(dnsTimeoutMillis,TimeUnit.MILLISECONDS)
            synchronized(cache) {
                if(inFlight[host]===lookup) {
                    cache[host]=System.currentTimeMillis() to allowed
                    inFlight.remove(host)
                }
            }
            allowed
        } catch(error:Exception) {
            synchronized(cache) {
                if(inFlight[host]===lookup) {
                    inFlight.remove(host)
                    lookup.cancel(true)
                    if(dns is ThreadPoolExecutor)(lookup as? Runnable)?.let{dns.remove(it)}
                }
            }
            if(error is InterruptedException)Thread.currentThread().interrupt()
            // Unresolved requests remain blocked. A timeout/admission/network failure
            // is not a completed private-address classification and must be retryable.
            false
        }
    }
    fun close() {
        synchronized(cache){inFlight.values.forEach{it.cancel(true)};inFlight.clear();cache.clear()}
        dns.shutdownNow()
    }
    companion object {
        fun origin(uri: URI): String = "${uri.scheme}://${uri.host}" + if(uri.port!=-1) ":${uri.port}" else ""
        fun publicAddress(address: InetAddress): Boolean {
            if(address.isAnyLocalAddress||address.isLoopbackAddress||address.isLinkLocalAddress||address.isSiteLocalAddress||address.isMulticastAddress)return false
            val b=address.address.map{it.toInt() and 255}
            if(b.size==4){val a=b[0];val c=b[1];return !(a==0||a==10||a==127||a>=224||(a==100&&c in 64..127)||(a==169&&c==254)||(a==172&&c in 16..31)||(a==192&&(c==0||c==168))||(a==198&&(c==18||c==19||(c==51&&b[2]==100)))||(a==203&&c==0&&b[2]==113))}
            return b.size==16 && (b[0] and 224)==32 && !(b[0]==32&&b[1]==2) && !(b[0]==32&&b[1]==1&&((b[2]==13&&b[3]==184)||(b[2]==0&&b[3]==0)))
        }
    }
}
