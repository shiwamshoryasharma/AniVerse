package app.aniverse.tablet

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.*
import android.widget.*
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.URI
import java.util.UUID
import java.util.concurrent.Executors

/** An owned browser WebView. It deliberately has no JavaScriptInterface or native message listener. */
class SourceActivity:Activity() {
    private lateinit var web:WebView
    private lateinit var title:TextView
    private lateinit var source:JSONObject
    private lateinit var policy:NetworkPolicy
    private lateinit var profileName:String
    private lateinit var root:LinearLayout
    private var media:JSONObject?=null
    private var episode=1
    private var privatePlayback=false
    private var phase=0
    private var polls=0
    private var episodeSteps=0
    private var generation=0
    private var selectedUrl:String?=null
    private var focused=false
    private var searchBusy=false
    private var searchAttempt=0
    private var titleMisses=0
    private var customView:View?=null
    private var fullscreenCallback:WebChromeClient.CustomViewCallback?=null
    private val handler=Handler(Looper.getMainLooper())
    private val io=Executors.newSingleThreadExecutor()
    private val app get()=application as TabletApplication
    private val preferences by lazy{getSharedPreferences("source-methods",MODE_PRIVATE)}
    private var method=JSONObject()
    private val probe=object:Runnable{override fun run(){captureProgress();handler.postDelayed(this,2500)}}
    override fun onCreate(state:Bundle?){
        super.onCreate(state)
        source=JSONObject(intent.getStringExtra("source") ?: return finish());media=intent.getStringExtra("media")?.let{JSONObject(it)}
        episode=intent.getIntExtra("episode",1).coerceIn(1,100000);privatePlayback=intent.getBooleanExtra("private",false)
        val sourceId=source.optString("id");require(sourceId.matches(Regex("[A-Za-z0-9_-]{1,200}")))
        profileName=if(privatePlayback)"private-"+UUID.randomUUID() else "source-"+sourceId
        policy=NetworkPolicy(if(BuildConfig.DEBUG)BuildConfig.TEST_ORIGIN else "")
        if(privatePlayback)window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        if(!privatePlayback){val saved=runCatching{JSONObject(preferences.getString(sourceId,"{}")!!)}.getOrDefault(JSONObject());if(saved.optInt("version",0)==1&&saved.optString("origin")==NetworkPolicy.origin(URI(source.getString("url")))&&System.currentTimeMillis()-saved.optLong("at",0)<30L*86400000)method=saved}
        root=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;setBackgroundColor(Color.rgb(17,12,23))}
        val toolbar=LinearLayout(this).apply{gravity=Gravity.CENTER_VERTICAL;setPadding(dp(5),0,dp(5),0)}
        toolbar.addView(button("‹","Back"){phase=3;selectedUrl=null;if(web.canGoBack())web.goBack()})
        toolbar.addView(button("›","Forward"){phase=3;selectedUrl=null;if(web.canGoForward())web.goForward()})
        toolbar.addView(button("↻","Reload source"){if(media!=null&&phase!=3)retryNavigation() else web.reload()})
        title=TextView(this).apply{setTextColor(Color.WHITE);textSize=13f;maxLines=2;setPadding(dp(10),0,dp(10),0);setOnClickListener{chooseEpisode()}}
        toolbar.addView(title,LinearLayout.LayoutParams(0,dp(52),1f))
        toolbar.addView(button("− EP","Previous episode"){changeEpisode((episode-1).coerceAtLeast(1))})
        toolbar.addView(button("+ EP","Next episode"){changeEpisode(episode+1)})
        toolbar.addView(button("Focus","Focus original player"){focus()})
        toolbar.addView(button("Done","Close source browser"){finish()})
        root.addView(toolbar,LinearLayout.LayoutParams(-1,dp(56)))
        web=WebView(this);WebViewCompat.setProfile(web,profileName)
        val profile=ProfileStore.getInstance().getOrCreateProfile(profileName)
        profile.serviceWorkerController.setServiceWorkerClient(object:ServiceWorkerClient(){override fun shouldInterceptRequest(request:WebResourceRequest):WebResourceResponse?=guard(request.url)})
        web.settings.apply{javaScriptEnabled=true;domStorageEnabled=true;allowFileAccess=false;allowContentAccess=false;setSupportMultipleWindows(true);javaScriptCanOpenWindowsAutomatically=false;mixedContentMode=WebSettings.MIXED_CONTENT_NEVER_ALLOW;safeBrowsingEnabled=true;mediaPlaybackRequiresUserGesture=true;if(privatePlayback)cacheMode=WebSettings.LOAD_NO_CACHE}
        web.webViewClient=object:WebViewClient(){
            override fun shouldInterceptRequest(view:WebView,request:WebResourceRequest):WebResourceResponse?=guard(request.url)
            override fun shouldOverrideUrlLoading(view:WebView,request:WebResourceRequest):Boolean {
                val uri=policy.validUrl(request.url.toString()) ?: return true
                return request.isForMainFrame&&!sameSource(uri.toString())
            }
            override fun onPageStarted(view:WebView,url:String,favicon:android.graphics.Bitmap?){generation++;focused=false;searchBusy=false;if(phase==3&&selectedUrl!=url)selectedUrl=null;status("Loading website…")}
            override fun onPageCommitVisible(view:WebView,url:String){handler.postDelayed({advance()},250)}
            override fun onPageFinished(view:WebView,url:String){
                if(!privatePlayback&&phase==1&&sameSource(url)){val query=searchQuery();if(query.isNotBlank()){val encoded=java.net.URLEncoder.encode(query,"UTF-8");for(value in listOf(encoded,encoded.replace("+","%20"),query))if(url.contains(value)){method.put("searchTemplate",url.replace(value,"{query}"));break}}}
                status(if(media==null)"Browser" else if(phase==3)"Episode $episode" else if(phase==2)"Finding episode $episode…" else "Finding the series…");handler.postDelayed({advance();focusWhenReady(0)},180)}
            override fun onReceivedSslError(view:WebView,handler:SslErrorHandler,error:android.net.http.SslError){handler.cancel();status("Website certificate rejected")}
            override fun onRenderProcessGone(view:WebView,detail:RenderProcessGoneDetail):Boolean{status("Website renderer stopped. Close and reopen this source.");root.removeView(web);web.destroy();return true}
        }
        web.webChromeClient=object:WebChromeClient(){
            override fun onCreateWindow(view:WebView,isDialog:Boolean,isUserGesture:Boolean,resultMsg:android.os.Message)=false
            override fun onPermissionRequest(request:PermissionRequest){request.deny()}
            override fun onGeolocationPermissionsShowPrompt(origin:String,callback:GeolocationPermissions.Callback){callback.invoke(origin,false,false)}
            override fun onShowFileChooser(view:WebView,callback:ValueCallback<Array<Uri>>,params:FileChooserParams)=false
            override fun onShowCustomView(view:View,callback:CustomViewCallback){if(customView!=null){callback.onCustomViewHidden();return};customView=view;fullscreenCallback=callback;root.visibility=View.GONE;addContentView(view,ViewGroup.LayoutParams(-1,-1));window.insetsController?.hide(android.view.WindowInsets.Type.systemBars())}
            override fun onHideCustomView(){hideFullscreen()}
        }
        web.setDownloadListener{url,_,_,mime,_->
            if(mime?.startsWith("video/")==true||mime=="application/octet-stream")AlertDialog.Builder(this).setTitle("Save for Local watch?").setMessage("Save this direct video-file link in the app's private storage. Downloads remain on this device until removed, including when started during private browsing.").setNegativeButton("Cancel",null).setPositiveButton("Download"){_,_->io.execute{try{require(policy.allow(url));val name=media?.optString("title")?.let{"$it · Episode $episode"} ?: "Saved episode";app.offline.addDownload(url,name);runOnUiThread{DownloadService.start(this);Toast.makeText(this,"Added to Downloads",Toast.LENGTH_SHORT).show()}}catch(_:Exception){runOnUiThread{Toast.makeText(this,"This download link is unavailable or blocked.",Toast.LENGTH_LONG).show()}}}}.show()
        }
        root.addView(web,LinearLayout.LayoutParams(-1,0,1f));root.keepSystemInsets();setContentView(root)
        onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT){if(customView!=null)hideFullscreen() else finish()}
        web.loadUrl(source.getString("url"));handler.postDelayed(probe,2500)
    }
    private fun dp(value:Int)=(value*resources.displayMetrics.density).toInt()
    private fun button(label:String,description:String,action:()->Unit)=Button(this).apply{text=label;contentDescription=description;textSize=12f;setTextColor(Color.rgb(255,183,117));setBackgroundColor(Color.TRANSPARENT);minWidth=dp(46);minHeight=dp(48);setPadding(dp(9),0,dp(9),0);setOnClickListener{action()}}
    private fun guard(uri:Uri):WebResourceResponse? {
        if(uri.scheme in setOf("data","blob","about"))return null
        return if(policy.allow(uri.toString()))null else WebResourceResponse("text/plain","UTF-8",403,"Blocked",mapOf("Cache-Control" to "no-store"),ByteArrayInputStream(ByteArray(0)))
    }
    private fun sameSource(value:String):Boolean=runCatching{val wanted=URI(source.getString("url"));val actual=URI(value);actual.scheme==wanted.scheme&&actual.port==wanted.port&&actual.host.removePrefix("www.").equals(wanted.host.removePrefix("www."),true)}.getOrDefault(false)
    private fun status(value:String){title.text=source.optString("name")+" · "+(media?.optString("title")?.let{"$it · "} ?: "")+value+(if(privatePlayback)" · Private" else "")}
    private fun operation(packet:JSONObject,callback:(JSONObject?)->Unit){
        val token=generation
        val template=assets.open("site-script.template").bufferedReader().use{it.readText()}
        web.evaluateJavascript(template.replace("__ANIVERSE_PAGE_ARGS__",packet.toString())){raw->if(token==generation&&!isDestroyed){val result=PageResults.objectResult(packet.optString("op"),raw);callback(result)}}
    }
    private fun remember(key:String,result:JSONObject?){if(privatePlayback)return;val selector=result?.optString("selector") ?: return;if(selector.isNotBlank()&&selector.length<=300)method.put(key,selector)}
    private fun find(op:String):JSONObject=JSONObject().put("op",op).apply{
        if(op=="findTitle"){put("titles",media?.optJSONArray("titles") ?: org.json.JSONArray().put(media?.optString("title","")));put("season",media?.optInt("season",1) ?: 1);method.optString("titleLink").takeIf{it.isNotBlank()}?.let{put("selector",it)}}
        if(op=="findEpisode"){put("episode",episode);put("slug",JSONObject.NULL);method.optString("episodeLink").takeIf{it.isNotBlank()}?.let{put("selector",it.replace("{n}",episode.toString()))}}
    }
    private fun searchQuery():String=media?.optJSONArray("titles")?.optString(0)?.takeIf{it.isNotBlank()} ?: media?.optString("title","") ?: ""
    private fun submitSearch(){
        if(phase!=1||isDestroyed)return
        web.requestFocus()
        val info=android.view.inputmethod.EditorInfo();val connection=web.onCreateInputConnection(info)
        val action=info.imeOptions and android.view.inputmethod.EditorInfo.IME_MASK_ACTION
        val handled=if(connection!=null&&action in setOf(android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH,android.view.inputmethod.EditorInfo.IME_ACTION_GO,android.view.inputmethod.EditorInfo.IME_ACTION_DONE))connection.performEditorAction(action) else false
        if(!handled){web.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_ENTER));web.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP,KeyEvent.KEYCODE_ENTER))}
    }
    private fun advance(){
        if(media==null||phase==3||polls++>45){if(polls>45)status("Choose the series/episode on the website");return}
        when(phase){
            0->{
                if(searchBusy)return
                val template=method.optString("searchTemplate").ifBlank{source.optString("searchTemplate")}
                if(template.contains("{query}")){val url=template.replace("{query}",java.net.URLEncoder.encode(searchQuery(),"UTF-8"));if(sameSource(url)){phase=1;web.loadUrl(url);return}}
                searchBusy=true
                operation(JSONObject().put("op","openSearch").put("attempt",searchAttempt).put("selector",method.optString("searchOpener"))){opened->
                    if(opened?.optBoolean("input")==true){
                        web.requestFocus()
                        operation(JSONObject().put("op","fillSearch").put("query",searchQuery()).put("selector",method.optString("searchInput"))){filled->
                            searchBusy=false
                            if(filled?.optBoolean("ok")==true){remember("searchInput",filled);phase=1;titleMisses=0;status("Searching for the series…");handler.postDelayed({submitSearch();handler.postDelayed({advance()},700)},700)}
                            else handler.postDelayed({advance()},450)
                        }
                    }else{
                        if(method.has("searchOpener")&&opened?.optBoolean("clicked")!=true)method.remove("searchOpener")
                        remember("searchOpener",opened?.takeIf{it.optBoolean("clicked")})
                        searchAttempt=if(opened?.optBoolean("more")==true)(searchAttempt+1).coerceAtMost(3) else 0
                        handler.postDelayed({searchBusy=false;advance()},500)
                    }
                }
            }
            1->operation(find("findTitle")){pick->if(pick!=null){remember("titleLink",pick);phase=2;follow(pick)}else {method.remove("titleLink");if(++titleMisses>=10&&method.has("searchTemplate")){method.remove("searchTemplate");phase=0;titleMisses=0};handler.postDelayed({advance()},500)}}
            2->operation(find("findEpisode")){pick->
                if(pick!=null){remember("episodeLink",pick);phase=3;follow(pick);selectedUrl=pick.optString("href").takeIf{it.isNotBlank()} ?: web.url;saveMethod();status("Episode $episode");handler.postDelayed({focusWhenReady(0)},500)}
                else if(method.has("episodeLink")){method.remove("episodeLink");handler.postDelayed({advance()},100)}
                else if(episodeSteps++==0)operation(JSONObject().put("op","episodesTab")){handler.postDelayed({advance()},400)}
                else if(episodeSteps==2)operation(JSONObject().put("op","watchLink").put("slug",JSONObject.NULL)){watch->if(watch!=null)follow(watch) else handler.postDelayed({advance()},400)}
                else handler.postDelayed({advance()},500)
            }
        }
    }
    private fun follow(pick:JSONObject){val href=pick.optString("href");if(href.isNotBlank()&&sameSource(href)){if(web.url!=href)web.loadUrl(href) else handler.postDelayed({advance()},100)}else{val key=pick.optString("pick");if(key.matches(Regex("[A-Za-z0-9_-]{1,100}")))operation(JSONObject().put("op","click").put("pick",key)){handler.postDelayed({advance()},500)}else status("Choose the episode on the website")}}
    private fun saveMethod(){if(privatePlayback)return;method.put("version",1).put("origin",NetworkPolicy.origin(URI(source.getString("url")))).put("at",System.currentTimeMillis());preferences.edit().putString(source.getString("id"),method.toString()).apply()}
    private fun retryNavigation(){generation++;searchBusy=false;searchAttempt=0;titleMisses=0;phase=0;polls=0;episodeSteps=0;selectedUrl=null;focused=false;web.loadUrl(source.getString("url"))}
    private fun changeEpisode(next:Int){if(media==null)return;generation++;searchBusy=false;episode=next.coerceIn(1,media?.optInt("episodes",100000)?.takeIf{it>0} ?: 100000);phase=2;episodeSteps=0;polls=0;selectedUrl=null;focused=false;advance()}
    private fun chooseEpisode(){if(media==null)return;val input=EditText(this).apply{inputType=android.text.InputType.TYPE_CLASS_NUMBER;setText(episode.toString())};AlertDialog.Builder(this).setTitle("Go to episode").setView(input).setNegativeButton("Cancel",null).setPositiveButton("Go"){_,_->input.text.toString().toIntOrNull()?.let{changeEpisode(it)}}.show()}
    private fun applyFocus(){
        val css=assets.open("source-focus.css").bufferedReader().use{it.readText()}
        web.evaluateJavascript("(()=>{let s=document.querySelector('#aniverse-focus');if(!s){s=document.createElement('style');s.id='aniverse-focus';document.head.append(s)}s.textContent="+JSONObject.quote(css)+";})()",null);focused=true
    }
    private fun focusWhenReady(attempt:Int){
        if(media==null||phase!=3||focused||isDestroyed||web.url!=selectedUrl)return
        operation(JSONObject().put("op","markPlayer").put("keep",true)){result->
            if(!result?.optString("tag").isNullOrBlank())applyFocus()
            else if(attempt<20)handler.postDelayed({focusWhenReady(attempt+1)},500)
        }
    }
    private fun focus(){
        if(focused){focused=false;operation(JSONObject().put("op","releasePlayer")){};web.evaluateJavascript("document.querySelector('#aniverse-focus')?.remove()",null)}
        else operation(JSONObject().put("op","markPlayer").put("keep",true)){result->if(!result?.optString("tag").isNullOrBlank())applyFocus() else status("Player not ready. Choose the episode on the website.")}
    }
    private fun captureProgress(){
        if(privatePlayback||media==null||phase!=3||web.url!=selectedUrl)return
        val token=generation;val currentEpisode=episode;val currentUrl=selectedUrl;val snapshot=media!!
        web.evaluateJavascript("(()=>{const v=document.querySelector('video');return v&&Number.isFinite(v.currentTime)&&Number.isFinite(v.duration)&&v.duration>0?{position:v.currentTime,duration:v.duration}:null})()"){raw->runCatching{val result=JSONObject(raw);val position=result.getDouble("position");val duration=result.getDouble("duration");if(token==generation&&currentEpisode==episode&&currentUrl==selectedUrl&&web.url==currentUrl&&position.isFinite()&&duration.isFinite()&&duration>0)MainActivity.progress(snapshot,currentEpisode,source.getString("id"),position.coerceAtLeast(0.0),duration)}}
    }
    private fun hideFullscreen(){customView?.let{(it.parent as? ViewGroup)?.removeView(it)};customView=null;root.visibility=View.VISIBLE;fullscreenCallback?.onCustomViewHidden();fullscreenCallback=null;window.insetsController?.show(android.view.WindowInsets.Type.systemBars())}
    override fun onPause(){web.onPause();super.onPause()}
    override fun onResume(){super.onResume();if(::web.isInitialized)web.onResume()}
    override fun onDestroy(){handler.removeCallbacksAndMessages(null);if(::web.isInitialized){web.stopLoading();web.destroy()};if(::profileName.isInitialized&&privatePlayback)runCatching{val profile=ProfileStore.getInstance().getProfile(profileName);profile?.cookieManager?.removeAllCookies(null);profile?.webStorage?.deleteAllData();ProfileStore.getInstance().deleteProfile(profileName)};if(::policy.isInitialized)policy.close();io.shutdownNow();super.onDestroy()}
}
