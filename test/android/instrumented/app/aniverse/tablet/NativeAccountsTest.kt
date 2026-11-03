package app.aniverse.tablet
import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
@RunWith(AndroidJUnit4::class)
class NativeAccountsTest {
 private val context=InstrumentationRegistry.getInstrumentation().targetContext
 private fun accepted(name:String)=JSONObject().put("status",200).put("body",JSONObject().put("data",JSONObject().put("Viewer",JSONObject().put("id",123).put("name",name).put("avatar",JSONObject().put("medium",JSONObject.NULL)))).toString())
 @Test fun credentialsAreEncryptedAndNotReturnedToTheUi(){val accounts=NativeAccounts(context);val token="fixture-only-token-never-a-real-account"
  try{accounts.verifyAndStore("anilist",token){_,candidate->assertEquals(token,candidate);accepted("Fixture account")};assertEquals(token,accounts.token("anilist"));assertFalse(accounts.list().toString().contains(token));val disk=context.getSharedPreferences("accounts",Context.MODE_PRIVATE).getString("token-anilist","")!!;assertFalse(disk.contains(token));assertTrue(disk.length>token.length)}finally{accounts.disconnect("anilist")}
 }
 @Test fun rejectedReplacementKeepsTheExistingVerifiedAccount(){val accounts=NativeAccounts(context);val old="fixture-original-credential";val other="fixture-invalid-replacement"
  try{accounts.verifyAndStore("anilist",old){_,_->accepted("Original fixture")};try{accounts.verifyAndStore("anilist",other){_,candidate->assertEquals(other,candidate);assertEquals(old,accounts.token("anilist"));JSONObject().put("status",401).put("body","{}")} ;fail("Rejected token replaced the account")}catch(expected:IllegalArgumentException){};assertEquals(old,accounts.token("anilist"));assertTrue(accounts.list().toString().contains("Original fixture"))}finally{accounts.disconnect("anilist")}
 }
 @Test fun validReplacementIsScopedToItsVerificationRequest(){val accounts=NativeAccounts(context);val old="fixture-original-credential";val replacement="fixture-new-credential"
  try{accounts.verifyAndStore("anilist",old){_,_->accepted("Original fixture")};accounts.verifyAndStore("anilist",replacement){_,candidate->assertEquals(replacement,candidate);assertEquals(old,accounts.token("anilist"));accepted("New fixture")};assertEquals(replacement,accounts.token("anilist"))}finally{accounts.disconnect("anilist")}
 }
}
