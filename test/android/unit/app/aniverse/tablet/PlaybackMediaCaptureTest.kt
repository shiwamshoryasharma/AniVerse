package app.aniverse.tablet

import org.junit.Assert.*
import org.junit.Test

class PlaybackMediaCaptureTest {
    private fun frame(src:String="https://media.example.test/episode.mp4",resources:List<String> = emptyList(),
                      encrypted:Boolean=false,played:Boolean=true,visible:Boolean=true)=PlaybackMediaCapture.Frame(
        "frame-1","https://player.example.test/embed/episode",src,resources,12.0,1440.0,640,360,4,played,visible,encrypted)
    private fun capture()=PlaybackMediaCapture().apply{reset(3)}
    private fun PlaybackMediaCapture.request(url:String)=observe(url,mapOf("Referer" to "https://player.example.test/embed/episode","User-Agent" to "FixtureAgent"),3)
    private fun rejected(work:()->Unit){try{work();fail("Unsafe or stale media was accepted")}catch(_:IllegalStateException){}}

    @Test fun directVideoRequiresAnObservedRequestAndKeepsNativeContext(){
        val value=capture();value.request("https://media.example.test/episode.mp4")
        val result=value.resolve(listOf(frame()),3)
        assertEquals("direct",result.kind);assertEquals("https://media.example.test/episode.mp4",result.url)
        assertEquals("https://player.example.test/embed/episode",result.referer);assertEquals("FixtureAgent",result.userAgent)
    }
    @Test fun bufferedMediaSurvivesUnrelatedPageRequestChurn(){
        val value=capture();value.request("https://media.example.test/episode.mp4")
        repeat(600){value.observe("https://api.example.test/item/"+it,emptyMap(),3)}
        assertEquals("https://media.example.test/episode.mp4",value.resolve(listOf(frame()),3).url)
    }
    @Test fun onlyActuallyObservedValidOriginsAreRetained(){
        for(origin in listOf("null","https://player.example.test:443")){
            val value=capture();value.observe("https://media.example.test/episode.mp4",mapOf("Origin" to origin),3)
            assertEquals(origin,value.resolve(listOf(frame()),3).origin)
        }
        for(origin in listOf("https://user@player.example.test","https://player.example.test/path","https://player.example.test?q=1","unsafe")){
            val value=capture();value.observe("https://media.example.test/episode.mp4",mapOf("Origin" to origin),3)
            assertNull(value.resolve(listOf(frame()),3).origin)
        }
    }
    @Test fun domUrlsAloneCannotCreateNativeRequests(){
        val value=capture()
        rejected{value.resolve(listOf(frame()),3)}
        value.request("https://media.example.test/other.mp4")
        rejected{value.resolve(listOf(frame()),3)}
    }
    @Test fun blobHlsUsesOnlyObservedResourcesFromItsOwningFrame(){
        val value=capture();val manifest="https://media.example.test/master.m3u8?signature=fixture"
        value.request(manifest)
        val result=value.resolve(listOf(frame("blob:https://player.example.test/local",listOf(manifest))),3)
        assertEquals(manifest,result.url);assertEquals("hls",result.kind)
        val wrong=capture();wrong.observe(manifest,mapOf("Referer" to "https://ads.example.test/ad"),3)
        rejected{wrong.resolve(listOf(frame("blob:https://player.example.test/local",listOf(manifest))),3)}
    }
    @Test fun encryptedUnplayedHiddenAndAmbiguousVideosAreRejected(){
        val value=capture();value.request("https://media.example.test/episode.mp4")
        rejected{value.resolve(listOf(frame(encrypted=true)),3)}
        rejected{value.resolve(listOf(frame(played=false)),3)}
        rejected{value.resolve(listOf(frame(visible=false)),3)}
        rejected{value.resolve(listOf(frame(),frame().copy(id="ad-frame")),3)}
    }
    @Test fun navigationRevokesRequestsAndPendingPublication(){
        val value=capture();value.request("https://media.example.test/episode.mp4")
        value.reset(4)
        rejected{value.resolve(listOf(frame()),3)}
        rejected{value.resolve(listOf(frame()),4)}
        var published=false
        rejected{value.commit(3){published=true}}
        assertFalse(published)
        value.observe("https://media.example.test/episode.mp4",emptyMap(),3)
        rejected{value.resolve(listOf(frame()),4)}
    }
    @Test fun multipleBlobPlaylistsCannotGuessAnAdOrPriorQuality(){
        val value=capture();val first="https://media.example.test/first.m3u8";val second="https://media.example.test/second.m3u8"
        value.request(first);value.request(second)
        rejected{value.resolve(listOf(frame("blob:https://player.example.test/local",listOf(first,second))),3)}
    }
    @Test fun sourceCookiePolicyCanOmitReferrerWithoutFabricatingIt(){
        val value=capture();value.observe("https://media.example.test/episode.mp4",emptyMap(),3)
        assertEquals("",value.resolve(listOf(frame()),3).referer)
    }
    @Test fun liveStreamsCannotBecomeAnUnboundedEpisodeDownload(){
        val value=capture();value.request("https://media.example.test/episode.mp4")
        rejected{value.resolve(listOf(frame().copy(duration=Double.POSITIVE_INFINITY)),3)}
    }
    @Test fun dashDoesNotMasqueradeAsAnOrdinaryVideoFile(){
        val value=capture();value.request("https://media.example.test/manifest.mpd")
        rejected{value.resolve(listOf(frame(src="https://media.example.test/manifest.mpd")),3)}
    }
}
