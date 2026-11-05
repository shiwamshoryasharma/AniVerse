package app.aniverse.tablet
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
@RunWith(AndroidJUnit4::class)
class PageResultsTest {
 @Test fun titleSearchUsesRankedArrayContract(){val picked=PageResults.objectResult("findTitle","[{\"href\":\"/series/chosen\",\"score\":0.99},{\"href\":\"/series/other\",\"score\":0.8}]");assertEquals("/series/chosen",picked!!.getString("href"));assertNull(PageResults.objectResult("findTitle","[]"));assertNull(PageResults.objectResult("findTitle","{\"href\":\"/wrong-contract\"}"))}
 @Test fun episodeLabelsAreBoundedAndDoNotExposePageData(){
  val cards=PageResults.episodeCards("[{\"episode\":2,\"audio\":[\"dub\",\"sub\",\"bad\"],\"thumbnail\":\"https://private.example.test/image\",\"href\":\"/private\"},{\"episode\":2},{\"episode\":0},{\"episode\":2.5},{\"episode\":5001},{\"episode\":1}]")
  assertEquals(2,cards.length());assertEquals(2,cards.getJSONObject(0).getInt("episode"));assertEquals(2,cards.getJSONObject(0).getJSONArray("audio").length());assertFalse(cards.getJSONObject(0).has("href"));assertFalse(cards.getJSONObject(0).has("thumbnail"))
  assertEquals(0,PageResults.episodeCards("null").length());assertEquals(0,PageResults.episodeCards("{}".repeat(256*1024)).length())
 }
 @Test fun playerTagAndOrdinaryObjectsHaveDistinctContracts(){assertEquals("VIDEO",PageResults.objectResult("markPlayer","{\"found\":true,\"tag\":\"VIDEO\"}")!!.getString("tag"));assertNull(PageResults.objectResult("markPlayer","null"));assertTrue(PageResults.objectResult("fillSearch","{\"ok\":true}")!!.getBoolean("ok"));assertNull(PageResults.objectResult("fillSearch","[]"));assertNull(PageResults.objectResult("findTitle","x".repeat(256*1024+1)))}
}
