package app.aniverse.tablet

import org.junit.Assert.*
import org.junit.Test

class HlsCaptureResolverTest {
    @Test fun masterVariantAndAudioResolveAsOneEpisode(){
        val root="https://media.example.test/show/master.m3u8?token=private"
        val variant="https://media.example.test/show/720/video.m3u8"
        val audio="https://media.example.test/show/audio/main.m3u8"
        val text="#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"audio/main.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO=\"a\"\n720/video.m3u8\n"
        val links=HlsCaptureGraph.links(text,root)
        assertEquals(setOf(variant,audio),links)
        assertEquals(root,HlsCaptureGraph.choose(listOf(audio,variant,root),mapOf(root to links)))
    }
    @Test fun multipleUnrelatedManifestsAreNotGuessed(){
        val urls=listOf("https://media.example.test/episode.m3u8","https://ads.example.test/preroll.m3u8")
        try{HlsCaptureGraph.choose(urls,emptyMap());fail("unrelated streams accepted")}catch(_:IllegalStateException){}
    }
    @Test fun nestedMasterAndCycleHaveDefinedOutcomes(){
        val a="https://media.example.test/a.m3u8";val b="https://media.example.test/b.m3u8";val c="https://media.example.test/c.m3u8"
        assertEquals(a,HlsCaptureGraph.choose(listOf(c,b,a),mapOf(a to setOf(b),b to setOf(c))))
        try{HlsCaptureGraph.choose(listOf(a,b),mapOf(a to setOf(b),b to setOf(a)));fail("ambiguous cycle accepted")}catch(_:IllegalStateException){}
    }
}
