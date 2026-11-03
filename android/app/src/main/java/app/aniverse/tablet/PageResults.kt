package app.aniverse.tablet
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
/** Decode the actual shared DOM operation contracts, not a blanket object cast. */
object PageResults {
 fun objectResult(operation:String,raw:String):JSONObject? {
  if(raw.length>256*1024)return null
  val value=runCatching{JSONTokener(raw).nextValue()}.getOrNull()
  if(operation=="findTitle")return (value as? JSONArray)?.optJSONObject(0)
  return value as? JSONObject
 }
}
