package app.aniverse.tablet

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.TextView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.webkit.ProfileStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class MainActivity:Activity() {
    private lateinit var web:WebView
    private lateinit var accounts:NativeAccounts
    private lateinit var requests:NativeRequests
    private lateinit var policy:NetworkPolicy
    private val app get()=application as TabletApplication
    private val pending=AtomicInteger()
    private val executor=ThreadPoolExecutor(2,4,30,TimeUnit.SECONDS,ArrayBlockingQueue(16))
    private var picker:((Uri?)->Unit)?=null
    private val imports=java.util.concurrent.ConcurrentHashMap.newKeySet<ImportOperation>()
    private val networkExecutor=ThreadPoolExecutor(2,2,30,TimeUnit.SECONDS,ArrayBlockingQueue(8))
    override fun onCreate(state:Bundle?) {
        super.onCreate(state)
        current=java.lang.ref.WeakReference(this)
        if(resources.configuration.smallestScreenWidthDp<600){notice("AniVerse is for Android tablets", "This edition needs Android 15+ and a tablet screen of at least 600 dp. Phones and other device categories are not supported.");return}
        if(!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)||!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)){
            notice("Update Android System WebView", "AniVerse requires origin-restricted messages and separate browser profiles. Update Android System WebView before opening sources.");return
        }
        policy=NetworkPolicy(if(BuildConfig.DEBUG)BuildConfig.TEST_ORIGIN else "")
        accounts=NativeAccounts(this);requests=NativeRequests(policy,accounts)
                WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        for(name in ProfileStore.getInstance().allProfileNames.filter{it.startsWith("private-")})runCatching{ProfileStore.getInstance().deleteProfile(name)}
        web=WebView(this)
        setContentView(android.widget.FrameLayout(this).apply{setBackgroundColor(Color.rgb(12,9,16));keepSystemInsets();addView(web,android.widget.FrameLayout.LayoutParams(-1,-1))})
        web.setBackgroundColor(Color.rgb(12,9,16))
        web.settings.apply{javaScriptEnabled=true;domStorageEnabled=true;allowFileAccess=false;allowContentAccess=false;javaScriptCanOpenWindowsAutomatically=false;setSupportMultipleWindows(false);mixedContentMode=android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW;safeBrowsingEnabled=true;mediaPlaybackRequiresUserGesture=true}
        val loader=WebViewAssetLoader.Builder().addPathHandler("/assets/",WebViewAssetLoader.AssetsPathHandler(this)).addPathHandler("/thumbs/"){value->runCatching{val file=app.offline.thumbnail(value);if(file.exists())WebResourceResponse("image/jpeg","UTF-8",200,"OK",mapOf("Cache-Control" to "no-store"),file.inputStream()) else blocked()}.getOrElse{blocked()}}.build()
        web.webViewClient=object:WebViewClient(){
            override fun shouldOverrideUrlLoading(view:WebView,request:WebResourceRequest)=request.url.toString().substringBefore('#')!=APP_URL
            override fun shouldInterceptRequest(view:WebView,request:WebResourceRequest):WebResourceResponse? {
                if(request.method !in setOf("GET","HEAD"))return blocked()
                loader.shouldInterceptRequest(request.url)?.let{return it}
                if(request.url.scheme=="data"||request.url.scheme=="blob")return null
                return if(policy.allow(request.url.toString())) null else blocked()
            }
            override fun onReceivedSslError(view:WebView,handler:android.webkit.SslErrorHandler,error:android.net.http.SslError){handler.cancel()}
        }
        web.webChromeClient=object:android.webkit.WebChromeClient(){override fun onPermissionRequest(request:android.webkit.PermissionRequest){request.deny()}}
        WebViewCompat.addWebMessageListener(web,"AniVerseNative",setOf(APP_ORIGIN)){_,message,origin,isMainFrame,proxy->
            if(!isMainFrame||origin.toString()!=APP_ORIGIN)return@addWebMessageListener
            val text=message.data ?: return@addWebMessageListener
            var id:Any="invalid"
            var counted=false
            try {
                require(text.length<=4*1024*1024&&text.toByteArray(Charsets.UTF_8).size<=4*1024*1024){"Request exceeds its size budget."}
                val packet=JSONObject(text);id=packet.get("id");require((id is String&&id.length<=80)||(id is Number))
                val method=packet.getString("method");require(method.length<=60)
                require(method=="storage.save"||text.toByteArray(Charsets.UTF_8).size<=64*1024){"Request exceeds its method budget."}
                val input=packet.optJSONObject("input") ?: JSONObject()
                if(pending.incrementAndGet()>8){pending.decrementAndGet();error("Too many active native requests.")}
                counted=true
                dispatch(method,input,id,proxy)
            }catch(error:Exception){send(proxy,id,null,error,counted)}
        }
        onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT){if(::web.isInitialized)web.evaluateJavascript("window.history.back()",null) else finish()}
        web.loadUrl(APP_URL)
        onNewIntent(intent)
    }
    private fun notice(title:String,text:String){setContentView(TextView(this).apply{setPadding(40,40,40,40);setTextColor(Color.WHITE);setBackgroundColor(Color.rgb(12,9,16));textSize=20f;this.text=title+"\n\n"+text;keepSystemInsets()})}
    private fun blocked()=WebResourceResponse("text/plain","UTF-8",403,"Blocked",mapOf("Cache-Control" to "no-store"),ByteArrayInputStream(ByteArray(0)))
    private fun send(proxy:JavaScriptReplyProxy,id:Any,value:Any?,error:Exception?=null,decrement:Boolean=true){
        if(decrement)pending.decrementAndGet()
        val result=JSONObject().put("id",id)
        if(error==null)result.put("result",value ?: JSONObject.NULL) else result.put("error",JSONObject().put("code","invalid-input").put("message",(error.message ?: "Native request failed.").take(400)))
        runOnUiThread{if(!isDestroyed)runCatching{proxy.postMessage(result.toString())}}
    }
    private fun dispatch(method:String,input:JSONObject,id:Any,proxy:JavaScriptReplyProxy){
        val reply:(Any?)->Unit={send(proxy,id,it)}
        val fail:(Exception)->Unit={send(proxy,id,null,it)}
        when(method){
            "offline.import"->{val store=app.offline;choose("video/*",arrayOf("video/*")){uri->if(uri==null)reply(null) else importFile(reply,fail){operation->store.importVideo(uri,operation)}}}
            "offline.subtitle"->{val item=input.getString("id");val store=app.offline;choose("*/*",arrayOf("application/x-subrip","text/vtt","text/plain","application/octet-stream")){uri->if(uri==null)reply(null) else importFile(reply,fail){operation->store.importSubtitle(item,uri,operation)}}}
            "accounts.configure"->configure(input.optString("provider"),reply,fail)
            else->try{(if(method=="api.request")networkExecutor else executor).execute{try{val result=handle(method,input);reply(result)}catch(error:Exception){fail(error)}}}catch(error:Exception){fail(error)}
        }
    }
    private fun importFile(reply:(Any?)->Unit,fail:(Exception)->Unit,work:(ImportOperation)->Any?){
        val ref=java.util.concurrent.atomic.AtomicReference<ImportOperation?>()
        val operation=ImportJobs.start({value,error->ref.get()?.let{imports.remove(it)};if(error==null)reply(value) else fail(error)},work=work)
        ref.set(operation);imports.add(operation);if(!operation.isActive)imports.remove(operation)
    }
    private fun choose(type:String,mimes:Array<String>,callback:(Uri?)->Unit){
        if(picker!=null){callback(null);return};picker=callback
        startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply{addCategory(Intent.CATEGORY_OPENABLE);this.type=type;putExtra(Intent.EXTRA_MIME_TYPES,mimes)},610)
    }
    @Deprecated("Platform result dispatcher")
    override fun onActivityResult(requestCode:Int,resultCode:Int,data:Intent?){super.onActivityResult(requestCode,resultCode,data);if(requestCode==610){val callback=picker;picker=null;callback?.invoke(if(resultCode==RESULT_OK)data?.data else null)}}
    private fun configure(provider:String,reply:(Any?)->Unit,fail:(Exception)->Unit){
        if(BuildConfig.TEST_ORIGIN.isNotBlank()){fail(IllegalStateException("Account entry is disabled in fixture builds. Use the normal app."));return}
        if(provider !in setOf("anilist","mal")){fail(IllegalArgumentException("Choose AniList or MyAnimeList."));return}
        val entry=EditText(this).apply{inputType=InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD;hint="OAuth access token";isSingleLine=true;importantForAutofill=View.IMPORTANT_FOR_AUTOFILL_NO;imeOptions=android.view.inputmethod.EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING}
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val dialog=AlertDialog.Builder(this).setTitle(if(provider=="anilist")"Connect AniList" else "Connect MyAnimeList").setMessage("Paste your OAuth access token. A client ID identifies an app and cannot authorize account sync. The token is checked with the official provider and encrypted by Android Keystore; source websites never receive it.").setView(entry).setNegativeButton("Cancel"){_,_->window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE);reply(null)}.setPositiveButton("Verify & save",null).create()
        dialog.setOnCancelListener{window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE);reply(null)}
        dialog.setOnShowListener{dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE);dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener{
            val token=entry.text.toString().trim();entry.setText("");dialog.dismiss();window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            executor.execute{try{accounts.verifyAndStore(provider,token){packet,candidate->requests.request(packet,candidate)};reply(accounts.list())}catch(error:Exception){fail(error)}}
        }};dialog.show()
    }
    private fun handle(method:String,input:JSONObject):Any?=when(method){
        "native.info"->JSONObject().put("version",BuildConfig.VERSION_NAME).put("platform","android").put("buildType",BuildConfig.BUILD_TYPE).put("fixture",BuildConfig.TEST_ORIGIN.isNotBlank()).put("sdkInt",Build.VERSION.SDK_INT).put("tablet",resources.configuration.smallestScreenWidthDp>=600).put("smallestWidthDp",resources.configuration.smallestScreenWidthDp).put("securityPatch",Build.VERSION.SECURITY_PATCH).put("webViewVersion",WebViewCompat.getCurrentWebViewPackage(this)?.versionName ?: "unknown").put("webViewUpdatedAtMs",WebViewCompat.getCurrentWebViewPackage(this)?.lastUpdateTime ?: 0).put("upscaling",false).put("sandbox",JSONObject().put("appPrivateStorage",true).put("originRestrictedBridge",true).put("websiteNativeBridge",false).put("multiProfile",true))
        "storage.load"->app.store.load()
        "storage.save"->{app.store.save(input.getJSONObject("value"));true}
        "api.request"->requests.request(input)
        "privacy.state"->JSONObject().put("incognito",app.incognito)
        "privacy.set"->{app.incognito=input.getBoolean("incognito");app.incognito}
        "sources.validate"->{val url=input.getString("url");require(policy.allow(url)){"Use a public HTTPS source website. Private, local and unsafe addresses are blocked."};JSONObject().put("url",url)}
        "sources.open"->{
            val sourceId=input.getString("id");require(sourceId.matches(Regex("[A-Za-z0-9_-]{1,200}")));val all=app.store.load().optJSONArray("sources") ?: JSONArray()
            val source=(0 until all.length()).map{all.getJSONObject(it)}.firstOrNull{it.optString("id")==sourceId&&it.optBoolean("enabled",true)} ?: error("Source not found or disabled.")
            require(policy.allow(source.getString("url"))){"This source URL is blocked. Use a public HTTPS website."}
            val media=input.optJSONObject("media");val privateIds=app.store.load().optJSONArray("privateMediaIds") ?: JSONArray();val privateTitle=media!=null&&(0 until privateIds.length()).any{privateIds.optLong(it)==media.optLong("id")}
            runOnUiThread{startActivity(Intent(this,SourceActivity::class.java).putExtra("source",source.toString()).putExtra("media",media?.toString()).putExtra("episode",input.optInt("episode",1).coerceIn(1,100000)).putExtra("private",app.incognito||privateTitle))};true
        }
        "sources.clear"->{val sourceId=input.getString("id");require(sourceId.matches(Regex("[A-Za-z0-9_-]{1,200}")));val task=java.util.concurrent.FutureTask<Boolean>{val profiles=ProfileStore.getInstance();val name="source-"+sourceId;check(name !in profiles.allProfileNames||profiles.deleteProfile(name)){"Close this source browser before clearing its data."};getSharedPreferences("source-methods",MODE_PRIVATE).edit().remove(sourceId).apply();true};runOnUiThread(task);task.get(5,TimeUnit.SECONDS)}
        "offline.list"->app.offline.list()
        "offline.play"->{val value=input.getString("id");app.offline.video(value);runOnUiThread{startActivity(Intent(this,OfflinePlayerActivity::class.java).putExtra("id",value).putExtra("private",app.incognito))};true}
        "offline.remove"->{app.offline.remove(input.getString("id"));true}
        "downloads.list"->{app.offline.downloads().also{rows->for(i in 0 until rows.length()){val row=rows.getJSONObject(i);row.put("speedBytesPerSecond",DownloadService.speed[row.getString("id")] ?: 0)}}}
        "downloads.add"->{val url=input.getString("url");require(policy.allow(url)){"Use a public HTTPS direct video-file URL."};val value=app.offline.addDownload(url,input.optString("title","Saved episode"));runOnUiThread{notificationPermission();DownloadService.start(this)};JSONObject().put("id",value)}
        "downloads.control"->{val value=input.getString("id");val action=input.getString("action");val record=app.offline.download(value);when(action){
            "pause"->{require(record.status in setOf("running","queued"));check(app.offline.updateDownload(value,"paused")){"Download state changed."};DownloadService.interrupt(value)}
            "resume","retry"->{require(record.status in setOf("paused","failed"));check(app.offline.updateDownload(value,"queued")){"Download state changed."};runOnUiThread{DownloadService.start(this)}}
            "cancel"->{require(record.status!="complete");check(app.offline.updateDownload(value,"cancelled")){"Download state changed."};DownloadService.interrupt(value);if(record.status!="running")app.offline.deleteDownload(value)}
            "remove"->{require(record.status=="complete");app.offline.deleteDownload(value)}
            else->error("Unknown download action.")
        };true}
        "accounts.list"->accounts.list()
        "accounts.disconnect"->{accounts.disconnect(input.getString("provider"));true}
        "accounts.synced"->{accounts.synced(input.getString("provider"));true}
        "external.open"->{val url=input.getString("url");require(policy.allow(url));runOnUiThread{startActivity(Intent(Intent.ACTION_VIEW,Uri.parse(url)))};true}
        else->error("Unknown native method.")
    }
    private fun notificationPermission(){if(checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)!=android.content.pm.PackageManager.PERMISSION_GRANTED)requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),611)}
    override fun onNewIntent(intent:Intent){super.onNewIntent(intent);val route=intent.getStringExtra("route");if(route in setOf("/downloads","/local")&&::web.isInitialized)web.evaluateJavascript("location.hash="+JSONObject.quote("#"+route),null)}
    override fun onConfigurationChanged(configuration:Configuration){super.onConfigurationChanged(configuration)}
    override fun onDestroy(){picker?.invoke(null);picker=null;for(operation in imports)operation.cancel();imports.clear();if(::web.isInitialized){web.stopLoading();web.destroy()};if(::policy.isInitialized)policy.close();executor.shutdownNow();networkExecutor.shutdownNow();super.onDestroy()}
    companion object {
        private var current=java.lang.ref.WeakReference<MainActivity>(null)
        fun progress(media:JSONObject,episode:Int,sourceId:String,position:Double,duration:Double){
            val activity=current.get() ?: return
            if(activity.app.incognito||!activity::web.isInitialized)return
            val event=JSONObject().put("media",media).put("episode",episode).put("sourceId",sourceId).put("position",position).put("duration",duration)
            activity.runOnUiThread{if(!activity.isDestroyed)activity.web.evaluateJavascript("window.dispatchEvent(new CustomEvent('tablet-progress',{detail:"+event.toString()+"}))",null)}
        }
        const val APP_ORIGIN="https://appassets.androidplatform.net";const val APP_URL=APP_ORIGIN+"/assets/index.html"}
}
