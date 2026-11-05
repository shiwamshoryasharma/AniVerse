package app.aniverse.tablet

import org.junit.Assert.*
import org.junit.Test

class SourceTransferChecksTest {
    private val vod="#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n"
    private fun reject(block:()->Unit){try{block();fail("Unsafe source input was accepted")}catch(_:IllegalArgumentException){}}
    @Test fun credentialsRemainBoundToTheExactCapturedMediaOrigin(){
        val request=SourceMediaRequest("https://media.example.test/a.mp4","https://site.example.test/episode","FixtureAgent","session=private","direct")
        assertEquals("session=private",request.headersFor("https://media.example.test/other")["Cookie"])
        for(url in listOf("https://other.example.test/a","http://media.example.test/a","https://media.example.test:444/a")){
            assertFalse(request.headersFor(url).containsKey("Cookie"));assertFalse(request.headersFor(url).containsKey("Referer"))
        }
        assertFalse(request.toString().contains("session=private"))
        assertFalse(request.toString().contains("media.example.test"))
        assertFalse(SourceMediaRequest("https://media.example.test/a","","Agent").headersFor("https://media.example.test/a").containsKey("Referer"))
        reject{SourceMediaRequest("https://media.example.test/a","https://site.example.test","Agent\nInjected")}
        reject{SourceMediaRequest("https://user:secret@media.example.test/a","","Agent")}
    }
    @Test fun observedOriginIsValidatedPersistableAndDestinationBound(){
        for(value in listOf("null","https://player.example.test","https://player.example.test:8443")){
            val request=SourceMediaRequest("https://media.example.test/a","","Agent",null,"hls",value)
            assertEquals(value,request.headersFor("https://media.example.test/segment")["Origin"])
            assertFalse(request.headersFor("https://other.example.test/segment").containsKey("Origin"))
            assertFalse(request.headersFor("http://media.example.test/segment").containsKey("Origin"))
            assertFalse(request.headersFor("https://media.example.test:444/segment").containsKey("Origin"))
        }
        for(value in listOf("","https://player.example.test/","https://player.example.test/path","https://player.example.test?q=x",
                "https://player.example.test#fragment","https://user:secret@player.example.test","https://player.example.test:0",
                "file://player.example.test","https://player.example.test\\r\\nInjected: value","x".repeat(2049))){
            reject{SourceMediaRequest("https://media.example.test/a","","Agent",null,"direct",value)}
        }
    }
    @Test fun standardVodAndOrdinaryAes128AreAcceptedWithoutCustomDecryption(){
        HlsChecks.validate(vod.toByteArray())
        HlsChecks.validate(vod.replace("#EXTINF:","#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",KEYFORMAT=\"identity\"\n#EXTINF:").toByteArray())
    }
    @Test fun liveDrmAndOversizedManifestsAreRejected(){
        reject{HlsChecks.validate(vod.replace("#EXT-X-ENDLIST\n","").toByteArray())}
        for(key in listOf("METHOD=SAMPLE-AES,URI=\"key\"","METHOD=AES-128,URI=\"key\",KEYFORMAT=\"com.widevine\"",
                "METHOD=AES-128,URI=\"key\",KEYFORMAT=com.widevine")){
            reject{HlsChecks.validate(vod.replace("#EXTINF:","#EXT-X-KEY:"+key+"\n#EXTINF:").toByteArray())}
        }
        reject{HlsChecks.validate(ByteArray(HlsChecks.MAX_PLAYLIST_BYTES+1))}
        reject{HlsChecks.validate("not a playlist".toByteArray())}
    }
    @Test fun opaqueMasterVariantAndAudioAddressesAreRegistered(){
        val master="#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"sound.php?track=1\"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO=\"a\"\nvariant.php?quality=1\n"
        assertEquals(listOf("https://media.example.test/path/sound.php?track=1","https://media.example.test/path/variant.php?quality=1"),
            HlsChecks.playlistUris(master.toByteArray(),"https://media.example.test/path/master.php"))
        reject{HlsChecks.playlistUris(master.replace("variant.php?quality=1","file:///private").toByteArray(),"https://media.example.test/master")}
    }
    @Test fun rangeResponsesRequireExactOffsetsLengthsAndTotals(){
        assertEquals(SourceRanges.Plan(0,10),SourceRanges.validate(206,"bytes 10-19/20",10,10,10))
        assertEquals(SourceRanges.Plan(10,10),SourceRanges.validate(200,null,20,10,-1))
        for(range in listOf("bytes 0-9/20","bytes 10-20/20","bytes 19-10/20","bytes 10-19/19","garbage"))
            reject{SourceRanges.validate(206,range,10,10,10)}
        reject{SourceRanges.validate(206,"bytes 10-19/20",9,10,10)}
        reject{SourceRanges.validate(206,"bytes 10-19/20",10,10,5)}
        reject{SourceRanges.validate(200,null,TransferChecks.MAX_FILE_BYTES+1,0,-1)}
    }
    @Test fun aggregateBudgetIncludesSkippedBytesAndRejectsDuplicateFlood(){
        val budget=SourceTransferBudget(maximum=15,maximumRequests=2)
        budget.request();budget.request();reject{budget.request()}
        budget.read(10);budget.read(5);reject{budget.read(1)}
        val resumed=SourceTransferBudget(maximum=15,initial=10);resumed.read(5);reject{resumed.read(1)}
    }
}
