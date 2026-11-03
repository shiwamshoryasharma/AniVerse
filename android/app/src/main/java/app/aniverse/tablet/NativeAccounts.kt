package app.aniverse.tablet

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Bearer credentials never enter the React document, source WebViews, URLs or logs. */
class NativeAccounts(context: Context) {
    private val prefs=context.getSharedPreferences("accounts",Context.MODE_PRIVATE)
    private val checking=ConcurrentHashMap.newKeySet<String>()
    private val allowed=setOf("anilist","mal")
    private fun key(): SecretKey {
        val store=KeyStore.getInstance("AndroidKeyStore").apply{load(null)}
        (store.getKey("aniverse-accounts",null) as? SecretKey)?.let{return it}
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore").apply{init(KeyGenParameterSpec.Builder("aniverse-accounts",KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build())}.generateKey()
    }
    private fun encrypt(token:String):String {
        val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key())
        return Base64.encodeToString(cipher.iv+cipher.doFinal(token.toByteArray()),Base64.NO_WRAP)
    }
    fun token(provider:String):String {
        require(provider in allowed)
        val value=prefs.getString("token-$provider",null) ?: error("Connect this account with an access token first.")
        return try{val bytes=Base64.decode(value,Base64.NO_WRAP);val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),GCMParameterSpec(128,bytes.copyOfRange(0,12)));String(cipher.doFinal(bytes.copyOfRange(12,bytes.size)),Charsets.UTF_8)}catch(_:Exception){error("This saved credential is unavailable. Reconnect the account.")}
    }
    fun list():JSONArray=JSONArray().apply{for(provider in allowed){val profile=JSONObject(prefs.getString("profile-$provider","{}")!!);put(JSONObject().put("provider",provider).put("connected",prefs.contains("token-$provider")).put("clientIdConfigured",true).put("signingIn",checking.contains(provider)).put("needsReconnect",false).put("userId",profile.optLong("id",0)).put("userName",profile.opt("name") ?: JSONObject.NULL).put("avatar",profile.opt("avatar") ?: JSONObject.NULL).put("expiresAt",JSONObject.NULL).put("lastSyncAt",prefs.getLong("sync-$provider",0).takeIf{it>0} ?: JSONObject.NULL).put("lastError",JSONObject.NULL).put("pending",0))}}
    fun verifyAndStore(provider:String,candidate:String,request:(JSONObject,String)->JSONObject):JSONObject {
        require(provider in allowed);require(candidate.length in 8..8192&&candidate.none{it.isWhitespace()||it.code<33}){"Paste an OAuth access token, not a client ID or API client secret."}
        require(checking.add(provider)){"This account is already being checked."}
        try {
            val input=if(provider=="anilist")JSONObject().put("url","https://graphql.anilist.co").put("method","POST").put("authenticated",true).put("body",JSONObject().put("query","query { Viewer { id name avatar { medium } } }").toString()) else JSONObject().put("url","https://api.myanimelist.net/v2/users/@me").put("authenticated",true)
            val response=request(input,candidate);require(response.getInt("status") in 200..299){"The provider rejected this credential. Paste a valid access token."}
            val body=JSONObject(response.getString("body"));val raw=if(provider=="anilist")body.getJSONObject("data").getJSONObject("Viewer") else body
            require(raw.optLong("id",0)>0&&raw.optString("name").isNotBlank()){"The token did not identify an account."}
            val profile=JSONObject().put("id",raw.getLong("id")).put("name",raw.getString("name")).put("avatar",if(provider=="anilist")raw.optJSONObject("avatar")?.opt("medium") ?: JSONObject.NULL else raw.opt("picture") ?: JSONObject.NULL)
            check(prefs.edit().putString("token-$provider",encrypt(candidate)).putString("profile-$provider",profile.toString()).commit()){"Could not save the encrypted credential."}
            return profile
        } finally{checking.remove(provider)}
    }
    fun disconnect(provider:String){require(provider in allowed);prefs.edit().remove("token-$provider").remove("profile-$provider").remove("sync-$provider").apply()}
    fun synced(provider:String){require(provider in allowed);prefs.edit().putLong("sync-$provider",System.currentTimeMillis()/1000).apply()}
}
