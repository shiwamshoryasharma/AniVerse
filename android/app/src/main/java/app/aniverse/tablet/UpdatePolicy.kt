package app.aniverse.tablet

import java.net.URI
import java.util.Locale

/** Pure restrictions for Android release selection and package verification. */
internal object UpdatePolicy {
    const val REPOSITORY = "shiwamshoryasharma/AniVerse"
    const val MAX_APK_BYTES = 256L * 1024 * 1024
    private val versionPattern = Regex("(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})")
    private val assetHosts = setOf("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com")
    data class Version(val major:Int,val minor:Int,val patch:Int):Comparable<Version> {
        override fun compareTo(other:Version):Int = compareValuesBy(this,other,{it.major},{it.minor},{it.patch})
    }
    fun version(value:String):Version? {
        val match=versionPattern.matchEntire(value) ?: return null
        return Version(match.groupValues[1].toInt(),match.groupValues[2].toInt(),match.groupValues[3].toInt())
    }
    fun releaseVersion(tag:String):String? = tag.takeIf{it.startsWith("android-v")}?.removePrefix("android-v")?.takeIf{version(it)!=null}
    fun newer(candidate:String,installed:String):Boolean {
        val next=version(candidate) ?: return false
        val current=version(installed) ?: return false
        return next>current
    }
    fun assetUrl(tag:String,name:String):String {
        val release=requireNotNull(releaseVersion(tag)){"Invalid Android release tag."}
        require(name=="AniVerse-Android-$release.apk" || name=="SHA256SUMS.txt")
        return "https://github.com/"+REPOSITORY+"/releases/download/"+tag+"/"+name
    }
    fun allowedDownload(value:String):Boolean=runCatching {
        require(value.length<=8192&&value.none{it.code<32})
        val uri=URI(value)
        uri.scheme=="https"&&uri.rawUserInfo==null&&uri.port in setOf(-1,443)&&
            uri.fragment==null&&uri.host?.lowercase(Locale.ROOT) in assetHosts
    }.getOrDefault(false)
    fun checksum(text:String,filename:String):String {
        require(text.toByteArray(Charsets.UTF_8).size<=64*1024)
        val values=text.lineSequence().mapNotNull{
            val match=Regex("^([a-fA-F0-9]{64})\\s+\\*?([^\\r\\n]+)$").matchEntire(it.trim())
            match?.takeIf{row->row.groupValues[2]==filename}?.groupValues?.get(1)
        }.toList()
        require(values.size==1){"The release must contain exactly one checksum for the Android APK."}
        return values.single().lowercase(Locale.ROOT)
    }
    fun verifyPackage(installedPackage:String,candidatePackage:String,installedCode:Long,candidateCode:Long,
                      installedSigners:Set<String>,candidateSigners:Set<String>) {
        require(installedPackage=="app.aniverse.tablet"&&candidatePackage==installedPackage){"The APK belongs to a different app."}
        require(candidateCode>installedCode){"The APK is not newer than the installed app."}
        require(installedSigners.isNotEmpty()&&candidateSigners==installedSigners){"The APK signing identity does not match this installation."}
    }
}
