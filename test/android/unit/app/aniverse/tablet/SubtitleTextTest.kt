package app.aniverse.tablet
import org.junit.Assert.*
import org.junit.Test
class SubtitleTextTest {
 @Test fun convertsSrtWithoutChangingDialogueOrIdentifiers(){assertEquals("WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.250\nHello, world!\n",SubtitleText.toVtt("\uFEFF1\r\n00:00:01,000 --> 00:00:03,250\r\nHello, world!\r\n"))}
 @Test fun keepsVttSettingsAndStyles(){val text="WEBVTT\n\n00:01.000 --> 00:03.000 align:start\n<i>Travel</i>\n";assertEquals(text,SubtitleText.toVtt(text))}
 @Test fun rejectsInvalidOrBinaryText(){for(text in listOf("not subtitles","WEBVTT\n\nno timed cues","1\n00:00:01,000 --> 00:00:03,000\n\u0000")){try{SubtitleText.toVtt(text);fail("Invalid subtitle accepted")}catch(expected:IllegalArgumentException){}}}
}
