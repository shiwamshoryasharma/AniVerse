package app.aniverse.tablet

import org.junit.Assert.*
import org.junit.Test

class UpdatePolicyTest {
    private val hash="a".repeat(64)
    private fun reject(work:()->Unit){try{work();fail("Unsafe update was accepted")}catch(_:IllegalArgumentException){}}
    @Test fun androidTagsExcludeWindowsPrereleasesAndMalformedVersions(){
        assertEquals("0.4.5",UpdatePolicy.releaseVersion("android-v0.4.5"))
        for(tag in listOf("v2.2.1","android-v0.4.5-beta","android-v01.4.5","android-v0.4.5/evil","android-v9999999.1.1"))
            assertNull(UpdatePolicy.releaseVersion(tag))
    }
    @Test fun versionsCompareNumericallyAndRejectDowngrades(){
        assertTrue(UpdatePolicy.newer("0.10.0","0.4.5"));assertTrue(UpdatePolicy.newer("1.0.0","0.99.99"))
        assertFalse(UpdatePolicy.newer("0.4.5","0.4.5"));assertFalse(UpdatePolicy.newer("0.4.4","0.4.5"))
        assertFalse(UpdatePolicy.newer("invalid","0.4.5"))
    }
    @Test fun assetNamesAndRepositoryAreFixed(){
        assertEquals("https://github.com/shiwamshoryasharma/AniVerse/releases/download/android-v0.4.5/AniVerse-Android-0.4.5.apk",UpdatePolicy.assetUrl("android-v0.4.5","AniVerse-Android-0.4.5.apk"))
        reject{UpdatePolicy.assetUrl("android-v0.4.5","../evil.apk")}
        reject{UpdatePolicy.assetUrl("v2.2.1","SHA256SUMS.txt")}
    }
    @Test fun redirectsRequireExactHttpsGithubAssetHosts(){
        assertTrue(UpdatePolicy.allowedDownload("https://release-assets.githubusercontent.com/asset?signature=value"))
        assertTrue(UpdatePolicy.allowedDownload("https://github.com/example"))
        for(url in listOf("http://github.com/file","https://github.com.evil.test/file","https://github.com@evil.test/file",
                "https://github.com:444/file","https://127.0.0.1/file","https://api.github.com/file","https://objects.githubusercontent.com/file#fragment"))
            assertFalse(url,UpdatePolicy.allowedDownload(url))
    }
    @Test fun checksumIsForTheExactApkName(){
        val name="AniVerse-Android-0.4.5.apk"
        assertEquals(hash,UpdatePolicy.checksum(hash+"  "+name+"\n",name))
        assertEquals(hash,UpdatePolicy.checksum(hash.uppercase()+" *"+name+"\n",name))
        reject{UpdatePolicy.checksum(hash+"  other.apk\n",name)}
        reject{UpdatePolicy.checksum(hash+"  ../"+name+"\n",name)}
        reject{UpdatePolicy.checksum(hash+"  "+name+"\n"+hash+"  "+name+"\n",name)}
        reject{UpdatePolicy.checksum("bad  "+name+"\n",name)}
    }
    @Test fun signaturePackageAndVersionAreAllRequired(){
        val signers=setOf(hash)
        UpdatePolicy.verifyPackage("app.aniverse.tablet","app.aniverse.tablet",1,405,signers,signers)
        reject{UpdatePolicy.verifyPackage("app.aniverse.tablet","other.app",1,405,signers,signers)}
        reject{UpdatePolicy.verifyPackage("app.aniverse.tablet.debug","app.aniverse.tablet.debug",1,405,signers,signers)}
        reject{UpdatePolicy.verifyPackage("app.aniverse.tablet","app.aniverse.tablet",405,405,signers,signers)}
        reject{UpdatePolicy.verifyPackage("app.aniverse.tablet","app.aniverse.tablet",405,1,signers,signers)}
        reject{UpdatePolicy.verifyPackage("app.aniverse.tablet","app.aniverse.tablet",1,405,signers,setOf("b".repeat(64)))}
        reject{UpdatePolicy.verifyPackage("app.aniverse.tablet","app.aniverse.tablet",1,405,emptySet(),emptySet())}
    }
}
