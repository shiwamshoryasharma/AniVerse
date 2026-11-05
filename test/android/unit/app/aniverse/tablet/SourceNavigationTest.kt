package app.aniverse.tablet

import org.junit.Assert.*
import org.junit.Test

class SourceNavigationTest {
 @Test fun equivalentOriginsRetainNavigation(){
  assertTrue(SourceNavigation.sameSource("https://video.example.test/","https://www.video.example.test:443/episode/1"))
  assertTrue(SourceNavigation.sameSource("https://VIDEO.example.test/","https://video.example.test/search?q=title"))
  assertFalse(SourceNavigation.sameSource("https://video.example.test/","https://video.example.test:8443/episode/1"))
  assertFalse(SourceNavigation.sameSource("https://video.example.test/","http://video.example.test/episode/1"))
  assertFalse(SourceNavigation.sameSource("https://video.example.test/","https://video.example.test.attacker.test/episode/1"))
  assertFalse(SourceNavigation.sameSource("https://video.example.test/","https://user@video.example.test/episode/1"))
  assertFalse(SourceNavigation.sameSource("https://video.example.test/","javascript:alert(1)"))
 }
 @Test fun searchUsesBoundedDistinctAliases(){
  assertEquals(listOf("English title","Romaji title","日本語"),SourceNavigation.queries(listOf(" English title ","english title","","null","Romaji title","日本語"),"English title"))
  assertEquals(6,SourceNavigation.queries((1..20).map{"Title $it"},"Fallback").size)
  assertEquals(listOf("Fallback"),SourceNavigation.queries(listOf("x".repeat(201)),"Fallback"))
 }
}
