package app.aniverse.tablet

import org.junit.Assert.*
import org.junit.Test

class AdDomainsTest {
    private val rules=AdDomains(sequenceOf("+ads.example.test","-video.ads.example.test","!forced.video.ads.example.test"))
    @Test fun blocksSubdomainsWithoutSubstringFalsePositives(){
        assertTrue(rules.blocks("https://ads.example.test/tag.js"))
        assertTrue(rules.blocks("https://cdn.ads.example.test:443/media"))
        assertTrue(rules.blocks("https://ADS.EXAMPLE.TEST./tag"))
        assertFalse(rules.blocks("https://notads.example.test/video.mp4"))
        assertFalse(rules.blocks("https://ads.example.test.attacker.test/tag.js"))
        assertFalse(rules.blocks("https://video.example.test/ads.example.test"))
    }
    @Test fun exceptionsAndImportantRulesHaveDefinedPrecedence(){
        assertFalse(rules.blocks("https://video.ads.example.test/main.m3u8"))
        assertFalse(rules.blocks("https://cdn.video.ads.example.test/main.mp4"))
        assertTrue(rules.blocks("https://forced.video.ads.example.test/tag"))
    }
    @Test fun malformedOrNonNetworkAddressesAreLeftToMandatoryNetworkGuard(){
        for(url in listOf("not a URL","data:video/mp4;base64,aaa","blob:https://video.example.test/abc","javascript:alert(1)","https://video.example.test/episode"))assertFalse(rules.blocks(url))
    }
}
