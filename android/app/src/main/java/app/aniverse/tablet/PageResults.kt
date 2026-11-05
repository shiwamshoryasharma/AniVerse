package app.aniverse.tablet
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
/** Decode the actual shared DOM operation contracts, not a blanket object cast. */
object PageResults {
 /** Only publish bounded episode labels/audio; never relay media URLs or page HTML. */
 fun episodeCards(raw:String):JSONArray {
  val result=JSONArray()
  if(raw.length>256*1024)return result
  val cards=runCatching{JSONTokener(raw).nextValue() as? JSONArray}.getOrNull() ?: return result
  val seen=HashSet<Int>()
  for(index in 0 until minOf(cards.length(),500)){
   val card=cards.optJSONObject(index) ?: continue
   val number=card.optDouble("episode")
   if(!number.isFinite()||number%1.0!=0.0||number<1||number>5000||!seen.add(number.toInt()))continue
   val audio=JSONArray();val labels=card.optJSONArray("audio")
   for(label in listOf("sub","dub"))if((0 until (labels?.length() ?: 0)).any{labels!!.optString(it)==label})audio.put(label)
   result.put(JSONObject().put("episode",number.toInt()).put("audio",audio))
  }
  return result
 }

 fun objectResult(operation:String,raw:String):JSONObject? {
  if(raw.length>256*1024)return null
  val value=runCatching{JSONTokener(raw).nextValue()}.getOrNull()
  if(operation=="findTitle")return (value as? JSONArray)?.optJSONObject(0)
  return value as? JSONObject
 }
}
