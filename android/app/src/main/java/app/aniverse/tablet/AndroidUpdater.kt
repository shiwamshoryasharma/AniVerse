package app.aniverse.tablet

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Explicit user-requested updates from this app's public Android GitHub releases. */
internal class AndroidUpdater(private val activity:Activity) {
    private data class Release(val tag:String,val version:String,val apk:String,val size:Long,val digest:String?,val sums:String)
    private val busy=AtomicBoolean(false)
    private val closed=AtomicBoolean(false)
    @Volatile private var connection:HttpURLConnection?=null
    private val directory get()=File(activity.cacheDir,"updates")
    private val enabled get()=!BuildConfig.DEBUG&&BuildConfig.TEST_ORIGIN.isBlank()&&activity.packageName=="app.aniverse.tablet"
    private fun status(state:String,message:String)=JSONObject().put("state",state)
        .put("currentVersion",BuildConfig.VERSION_NAME).put("currentVersionCode",BuildConfig.VERSION_CODE).put("message",message)
    private fun <T> exclusive(work:()->T):T {
        check(busy.compareAndSet(false,true)){"An update operation is already running."}
        try { check(!closed.get()){"The update screen was closed."};return work() }
        finally { busy.set(false) }
    }
    private fun deadline(seconds:Long)=System.nanoTime()+TimeUnit.SECONDS.toNanos(seconds)
    private fun remaining(end:Long):Int {
        check(!closed.get()&&!Thread.currentThread().isInterrupted){"Update cancelled."}
        val millis=TimeUnit.NANOSECONDS.toMillis(end-System.nanoTime())
        check(millis>0){"The update request timed out. Try again on a stable connection."}
        return millis.coerceAtMost(15000).toInt().coerceAtLeast(1)
    }
    fun check():JSONObject=exclusive {
        if(!enabled)return@exclusive status("unavailable","Install the signed production APK to use Android release updates.")
        val end=deadline(25)
        var newest:Release?=null
        // Bounded pagination: at most 100 releases; Windows tags are never candidates.
        for(page in 1..2) {
            val url="https://api.github.com/repos/"+UpdatePolicy.REPOSITORY+"/releases?per_page=50&page="+page
            val values=JSONArray(String(read(url,4*1024*1024,end,api=true),Charsets.UTF_8))
            for(i in 0 until values.length()) {
                val candidate=release(values.getJSONObject(i)) ?: continue
                if(UpdatePolicy.newer(candidate.version,BuildConfig.VERSION_NAME)&&
                    (newest==null||UpdatePolicy.newer(candidate.version,newest.version)))newest=candidate
            }
            if(values.length()<50)break
        }
        newest?.let {
            status("available","Android "+it.version+" is available. Download and installation start only when you choose Install.")
                .put("version",it.version).put("tag",it.tag)
                .put("releaseUrl","https://github.com/"+UpdatePolicy.REPOSITORY+"/releases/tag/"+it.tag).put("sizeBytes",it.size)
        } ?: status("current","No newer stable Android release was found.")
    }
    fun install(tag:String):JSONObject=exclusive {
        check(enabled){"Updates are unavailable in debug or fixture builds."}
        val version=UpdatePolicy.releaseVersion(tag) ?: error("Invalid Android release tag.")
        check(UpdatePolicy.newer(version,BuildConfig.VERSION_NAME)){"Choose a newer Android release."}
        if(!activity.packageManager.canRequestPackageInstalls()) {
            onUi{activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+activity.packageName)))}
            return@exclusive status("permission-required","Allow updates from AniVerse in Android settings, return here, then tap Install again.").put("version",version)
        }
        val end=deadline(240)
        val metadata=JSONObject(String(read("https://api.github.com/repos/"+UpdatePolicy.REPOSITORY+"/releases/tags/"+tag,4*1024*1024,end,api=true),Charsets.UTF_8))
        val candidate=release(metadata) ?: error("This release has no complete stable Android update.")
        require(candidate.tag==tag)
        val name="AniVerse-Android-"+candidate.version+".apk"
        val expected=UpdatePolicy.checksum(String(read(candidate.sums,64*1024,end),Charsets.UTF_8),name)
        candidate.digest?.let{require(it=="sha256:"+expected){"GitHub's asset digest and release checksum disagree."}}
        check(directory.mkdirs()||directory.isDirectory){"Could not prepare private update storage."}
        val part=File(directory,"update.part")
        val target=File(directory,"update.apk")
        try {
            val hash=MessageDigest.getInstance("SHA-256")
            part.outputStream().use { output->
                transfer(candidate.apk,UpdatePolicy.MAX_APK_BYTES,end){bytes,count->output.write(bytes,0,count);hash.update(bytes,0,count)}
            }
            require(part.length()==candidate.size){"The downloaded APK size does not match its release."}
            require(hex(hash.digest())==expected){"The APK checksum does not match the release."}
            verifyArchive(part,candidate.version)
            // Only verified bytes become readable through the narrowly scoped FileProvider.
            check(!target.exists()||target.delete()){"Could not replace the previous update."}
            check(part.renameTo(target)){"Could not finalize the verified update."}
            onUi {
                val uri=FileProvider.getUriForFile(activity,activity.packageName+".updates",target)
                val intent=Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                intent.clipData=ClipData.newRawUri("AniVerse Android update",uri)
                activity.startActivity(intent)
            }
            status("installer-opened","The APK was verified. Confirm the update in Android's installer.").put("version",candidate.version)
        } finally {part.delete()}
    }
    private fun release(value:JSONObject):Release? {
        if(value.optBoolean("draft")||value.optBoolean("prerelease"))return null
        val tag=value.optString("tag_name")
        val version=UpdatePolicy.releaseVersion(tag) ?: return null
        val assets=value.optJSONArray("assets") ?: return null
        val name="AniVerse-Android-"+version+".apk"
        fun find(asset:String):JSONObject? {
            val found=(0 until assets.length()).mapNotNull(assets::optJSONObject).filter{it.optString("name")==asset&&it.optString("state")=="uploaded"}
            return found.singleOrNull()
        }
        val apk=find(name) ?: return null
        val sums=find("SHA256SUMS.txt") ?: return null
        if(apk.optString("browser_download_url")!=UpdatePolicy.assetUrl(tag,name)||sums.optString("browser_download_url")!=UpdatePolicy.assetUrl(tag,"SHA256SUMS.txt"))return null
        val size=apk.optLong("size")
        if(size !in 1..UpdatePolicy.MAX_APK_BYTES||sums.optLong("size") !in 1..65536)return null
        val digest=apk.optString("digest").takeIf{it.isNotBlank()&&it!="null"}
        if(digest!=null&&!Regex("sha256:[a-f0-9]{64}").matches(digest))return null
        return Release(tag,version,apk.getString("browser_download_url"),size,digest,sums.getString("browser_download_url"))
    }
    private fun verifyArchive(file:File,version:String) {
        val manager=activity.packageManager
        val flags=PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong())
        val installed=manager.getPackageInfo(activity.packageName,flags)
        val candidate=manager.getPackageArchiveInfo(file.absolutePath,flags) ?: error("The download is not a valid signed APK.")
        fun signers(info:android.content.pm.PackageInfo):Set<String> =
            info.signingInfo?.apkContentsSigners?.map{hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray()))}?.toSet() ?: emptySet()
        UpdatePolicy.verifyPackage(installed.packageName,candidate.packageName,installed.longVersionCode,candidate.longVersionCode,signers(installed),signers(candidate))
        require(candidate.versionName==version){"The APK version does not match its release tag."}
    }
    private fun read(url:String,limit:Int,end:Long,api:Boolean=false):ByteArray {
        val output=ByteArrayOutputStream()
        transfer(url,limit.toLong(),end,api){bytes,count->output.write(bytes,0,count)}
        return output.toByteArray()
    }
    private fun transfer(initial:String,limit:Long,end:Long,api:Boolean=false,accept:(ByteArray,Int)->Unit) {
        var current=initial
        for(redirect in 0..4) {
            if(api)require(current==initial&&current.startsWith("https://api.github.com/repos/"+UpdatePolicy.REPOSITORY+"/releases")){"Update API redirects are not allowed."}
            else require(UpdatePolicy.allowedDownload(current)){"The update redirect is not a trusted GitHub asset host."}
            val request=URL(current).openConnection() as HttpURLConnection
            connection=request
            try {
                request.instanceFollowRedirects=false;request.useCaches=false
                request.connectTimeout=minOf(10000,remaining(end));request.readTimeout=remaining(end)
                request.setRequestProperty("Accept",if(api)"application/vnd.github+json" else "application/octet-stream")
                request.setRequestProperty("Accept-Encoding","identity")
                request.setRequestProperty("User-Agent","AniVerse-Android/"+BuildConfig.VERSION_NAME)
                if(api)request.setRequestProperty("X-GitHub-Api-Version","2022-11-28")
                val response=request.responseCode;remaining(end)
                if(response in setOf(301,302,303,307,308)) {
                    require(!api&&redirect<4){"The update redirected too many times."}
                    val location=request.getHeaderField("Location") ?: error("The update redirect has no destination.")
                    current=URL(URL(current),location).toString();continue
                }
                check(response==200){if(response==403||response==429)"GitHub's update rate limit was reached. Try again later." else "GitHub update request failed ($response)."}
                require(request.contentLengthLong<=limit){"The update exceeds its size budget."}
                var bytes=0L
                request.inputStream.use { input->
                    val buffer=ByteArray(32768)
                    while(true) {
                        request.readTimeout=remaining(end)
                        val count=input.read(buffer);remaining(end)
                        if(count<0)break
                        bytes+=count;require(bytes<=limit){"The update exceeds its size budget."};accept(buffer,count)
                    }
                }
                return
            } finally {request.disconnect();if(connection===request)connection=null}
        }
        error("The update redirected too many times.")
    }
    private fun onUi(action:()->Unit) {
        val task=FutureTask<Unit>{check(!activity.isDestroyed&&!closed.get()){"The update screen was closed."};action()}
        activity.runOnUiThread(task);UpdateDispatch.await(task)
    }
    fun close(){closed.set(true);connection?.disconnect()}
    private fun hex(bytes:ByteArray)=bytes.joinToString(""){"%02x".format(it.toInt() and 255)}
}

/** Explicit subclass avoids OEM-dependent direct FileProvider instantiation. */
class UpdateFileProvider: FileProvider()
