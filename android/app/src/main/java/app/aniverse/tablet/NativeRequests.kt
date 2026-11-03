package app.aniverse.tablet

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.io.ByteArrayOutputStream

class NativeRequests(private val policy: NetworkPolicy, private val accounts: NativeAccounts) {
    fun request(input: JSONObject, accessTokenOverride: String? = null): JSONObject {
        val original=input.getString("url");val uri=java.net.URI(original)
        require(uri.scheme=="https"&&uri.rawUserInfo==null&&uri.port in listOf(-1,443)) { "Only official API requests are allowed." }
        val provider=when {
            uri.host=="graphql.anilist.co"&&uri.path in listOf("","/")->"anilist"
            uri.host=="api.myanimelist.net"&&uri.path.startsWith("/v2/")->"mal"
            else->error("Only official AniList and MyAnimeList APIs are allowed.")
        }
        val method=input.optString("method","GET");require(method in listOf("GET","POST","PUT","PATCH","DELETE"))
        val body=input.optString("body","");require(body.toByteArray().size<=512*1024)
        val authenticated=input.optBoolean("authenticated",false)
        val target=if(BuildConfig.DEBUG&&BuildConfig.TEST_ORIGIN.isNotBlank()&&provider=="anilist") BuildConfig.TEST_ORIGIN+"/graphql" else original
        require(policy.allow(target)) { "The API address is blocked by source protection." }
        val connection=URL(target).openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects=false;connection.connectTimeout=10000;connection.readTimeout=20000;connection.requestMethod=method
            connection.setRequestProperty("Accept","application/json");connection.setRequestProperty("Accept-Encoding","identity");connection.setRequestProperty("User-Agent","AniVerse-Android/0.1.0")
            if(authenticated)connection.setRequestProperty("Authorization","Bearer "+(accessTokenOverride ?: accounts.token(provider)))
            val contentType=input.optString("contentType","application/json");require(contentType in listOf("application/json","application/x-www-form-urlencoded"));connection.setRequestProperty("Content-Type",contentType)
            if(body.isNotEmpty()){connection.doOutput=true;connection.outputStream.use{it.write(body.toByteArray(Charsets.UTF_8))}}
            val status=connection.responseCode
            val stream=if(status<400)connection.inputStream else connection.errorStream
            val output=ByteArrayOutputStream();stream?.use{val buffer=ByteArray(8192);while(true){val n=it.read(buffer);if(n<0)break;require(output.size()+n<=8*1024*1024){"The API response exceeds its size budget."};output.write(buffer,0,n)}}
            return JSONObject().put("status",status).put("body",output.toString(Charsets.UTF_8.name())).put("retryAfter",connection.getHeaderField("Retry-After") ?: "")
        } finally { connection.disconnect() }
    }
}
