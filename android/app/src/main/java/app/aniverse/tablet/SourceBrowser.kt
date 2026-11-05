package app.aniverse.tablet

import android.app.Activity
import android.app.AlertDialog
import android.net.Uri
import android.net.http.SslError
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.*
import android.widget.*
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import org.json.JSONArray
import java.io.ByteArrayInputStream
import java.net.URI
import java.util.UUID
import java.util.concurrent.Executors

/** The source surface owns its WebView and browser profile in both playback layouts. */
internal class SourceBrowser(
    private val activity: Activity,
    private val source: JSONObject,
    private val media: JSONObject?,
    private val episode: Int,
    val privatePlayback: Boolean,
    private val onStatus: (String, String) -> Unit
) {
    val web = WebView(activity).apply { setBackgroundColor(android.graphics.Color.BLACK) }
    private val sourceId = source.getString("id")
    private val profileName = if (privatePlayback) "private-" + UUID.randomUUID() else "source-" + sourceId
    private val policy = NetworkPolicy(if (BuildConfig.DEBUG) BuildConfig.TEST_ORIGIN else "",
        additionalDebugOrigin=if(BuildConfig.DEBUG&&BuildConfig.TEST_ORIGIN.isNotBlank())BuildConfig.TEST_MEDIA_ORIGIN else "")
    private var closed = false
    private var rendererGone = false
    private var browserMode = media == null
    private var committed = false
    private var pendingDocument: String? = null
    private var navigationFailed = false
    private var focusTicket = 0
    private var focusPending = false
    private val template by lazy { activity.assets.open("site-script.template").bufferedReader().use { it.readText() } }
    private val focusCss by lazy { activity.assets.open("source-focus.css").bufferedReader().use { it.readText() } }
    private val isDestroyed get() = closed || rendererGone || activity.isDestroyed
    private var phase=0
    private var polls=0
    private var episodeSteps=0
    private var generation=0
    @Volatile private var downloadEpoch=0
    private val mediaCapture=PlaybackMediaCapture()
    private var confirmedAudio:String?=null
    private var audioChanging=false
    private var audioTicket=0
    private var downloadBusy=false
    private var downloadCancel:(()->Unit)?=null
    private val adsEnabled get()=source.optBoolean("adblock",true)
    private val telemetryPrefix="__aniverse_media_"+UUID.randomUUID().toString()+":"
    private val mediaReports=linkedMapOf<String,Pair<Long,PlaybackMediaCapture.Frame>>()
    private var reportWindow=0L
    private var reportCount=0
    private val playbackObserver by lazy { activity.assets.open("playback-observer.js").bufferedReader().use{it.readText()}
        .replace("__ANIVERSE_TELEMETRY_PREFIX__",JSONObject.quote(telemetryPrefix)) }
    private var selectedUrl:String?=null
    private var focused=false
    private var searchBusy=false
    private var searchAttempt=0
    private var searchOpeningUntil=0L
    private var queryIndex=0
    private var advanceBusy=false
    private var episodeCardsGeneration=-1
    private val advanceTask=Runnable { advance() }
    private val titleQueries by lazy {
        val titles=media?.optJSONArray("titles")
        SourceNavigation.queries((0 until (titles?.length() ?: 0)).map { titles!!.optString(it) },media?.optString("title","") ?: "")
    }
    var episodeCards=org.json.JSONArray()
        private set
    var episodesKnown=false
        private set
    var confirmedEpisode:Int?=null
        private set
    private var titleMisses=0
    private var customView:View?=null
    private var fullscreenCallback:WebChromeClient.CustomViewCallback?=null
    private val handler=Handler(Looper.getMainLooper())
    private val io=Executors.newSingleThreadExecutor()
    private val app get()=activity.application as TabletApplication
    private val preferences by lazy{activity.getSharedPreferences("source-methods",Activity.MODE_PRIVATE)}
    private var method=JSONObject()
    private val probe=object:Runnable{override fun run(){captureProgress();handler.postDelayed(this,2500)}}
    init {
        require(sourceId.matches(Regex("[A-Za-z0-9_-]{1,200}")))
        if (!privatePlayback) {
            val saved = runCatching { JSONObject(preferences.getString(sourceId, "{}")!!) }.getOrDefault(JSONObject())
            if (saved.optInt("version") == 1 &&
                saved.optString("origin") == NetworkPolicy.origin(URI(source.getString("url"))) &&
                System.currentTimeMillis() - saved.optLong("at") < 30L * 86400000
            ) method = saved
        }
        WebViewCompat.setProfile(web, profileName)
        val profile=ProfileStore.getInstance().getOrCreateProfile(profileName)
        profile.serviceWorkerController.setServiceWorkerClient(object:ServiceWorkerClient(){override fun shouldInterceptRequest(request:WebResourceRequest):WebResourceResponse?=intercept(request)})
        web.settings.apply{javaScriptEnabled=true;domStorageEnabled=true;allowFileAccess=false;allowContentAccess=false;setSupportMultipleWindows(true);javaScriptCanOpenWindowsAutomatically=false;mixedContentMode=WebSettings.MIXED_CONTENT_NEVER_ALLOW;safeBrowsingEnabled=true;mediaPlaybackRequiresUserGesture=true;if(privatePlayback)cacheMode=WebSettings.LOAD_NO_CACHE}
        web.webViewClient=object:WebViewClient(){
            override fun shouldInterceptRequest(view:WebView,request:WebResourceRequest):WebResourceResponse?=intercept(request)
            override fun shouldOverrideUrlLoading(view:WebView,request:WebResourceRequest):Boolean {
                if(adsEnabled&&app.adFilter.blocks(request.url.toString()))return true
                val uri=policy.validUrl(request.url.toString()) ?: return true
                if (!request.isForMainFrame) return false
                if (!sameSource(uri.toString())) return true
                if (!sameDocument(view.url, uri.toString())) expectDocument(uri.toString())
                return false
            }
            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                // WebView may report a synthetic start for a failed document before its error callback.
                if (navigationFailed) return
                generation++
                invalidateDownload()
                confirmedEpisode=null
                confirmedAudio=null
                pendingDocument = url
                committed = false
                focusTicket++
                focusPending = false
                focused = false
                searchBusy = false
                searchOpeningUntil = 0L
                advanceBusy = false
                handler.removeCallbacks(advanceTask)
                status("Loading website…", if (browserMode) "website" else "loading")
            }
            override fun onPageCommitVisible(view: WebView, url: String) {
                if (navigationFailed || pendingDocument?.let { !sameDocument(it, url) } == true) return
                pendingDocument = null
                committed = true
                scheduleAdvance(100)
                later(100) { focusWhenReady() }
            }
            override fun onPageFinished(view:WebView,url:String){
                if (navigationFailed || pendingDocument?.let { !sameDocument(it, url) } == true) return
                pendingDocument = null
                committed = true
                installPageObservers()
                if(!privatePlayback&&phase==1&&sameSource(url)){val query=searchQuery();if(query.isNotBlank()){val encoded=java.net.URLEncoder.encode(query,"UTF-8");for(value in listOf(encoded,encoded.replace("+","%20"),query))if(url.contains(value)){method.put("searchTemplate",url.replace(value,"{query}"));break}}}
                status(if(media==null)"Browser" else if(phase==3)"Loading episode $episode…" else if(phase==2)"Finding episode $episode…" else "Finding the series…");scheduleAdvance(80);later(80){focusWhenReady()}}
            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                if(confirmedEpisode!=null&&!sameEpisodePage(url)){
                    confirmedEpisode=null
                    invalidateDownload()
                    status("Website navigation changed the selected episode.",if(browserMode)"website" else "needs-site")
                }
            }
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                handler.cancel()
                // This callback includes subresources. A late failure must not hide a loaded episode.
                if (sameDocument(pendingDocument, error.url)) failNavigation(certificate = true)
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                if (pendingDocument?.let { !sameDocument(it, request.url.toString()) } == true) return
                failNavigation(certificate = error.errorCode == ERROR_FAILED_SSL_HANDSHAKE)
            }
            override fun onRenderProcessGone(view:WebView,detail:RenderProcessGoneDetail):Boolean{rendererGone=true;handler.removeCallbacksAndMessages(null);hideFullscreen();(web.parent as? ViewGroup)?.removeView(web);web.destroy();status("The website renderer stopped. Reload to try again.", "error");return true}
        }
        if(WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)){
            WebViewCompat.addDocumentStartJavaScript(web,playbackObserver,setOf("*"))
            if(adsEnabled)WebViewCompat.addDocumentStartJavaScript(web,app.adFilter.script,setOf("*"))
        }
        web.webChromeClient=object:WebChromeClient(){
            override fun onConsoleMessage(message:ConsoleMessage):Boolean {
                val text=message.message()
                if(!text.startsWith(telemetryPrefix))return false
                receiveMediaReport(text.substring(telemetryPrefix.length))
                return true
            }
            override fun onCreateWindow(view:WebView,isDialog:Boolean,isUserGesture:Boolean,resultMsg:android.os.Message)=false
            override fun onPermissionRequest(request:PermissionRequest){request.deny()}
            override fun onGeolocationPermissionsShowPrompt(origin:String,callback:GeolocationPermissions.Callback){callback.invoke(origin,false,false)}
            override fun onShowFileChooser(view:WebView,callback:ValueCallback<Array<Uri>>,params:FileChooserParams)=false
            override fun onShowCustomView(view:View,callback:CustomViewCallback){if(customView!=null||!web.isShown||web.alpha==0f){callback.onCustomViewHidden();return};customView=view;fullscreenCallback=callback;activity.addContentView(view,ViewGroup.LayoutParams(-1,-1));activity.window.insetsController?.hide(android.view.WindowInsets.Type.systemBars())}
            override fun onHideCustomView(){hideFullscreen()}
        }
        web.setDownloadListener{url,downloadAgent,_,mime,_->
            if(mime?.startsWith("video/")==true||mime=="application/octet-stream")AlertDialog.Builder(activity).setTitle("Save for Local watch?").setMessage("Save this direct video-file link in the app's private storage. Downloads remain on this device until removed, including when started during private browsing.").setNegativeButton("Cancel",null).setPositiveButton("Download"){_,_->
                val request=runCatching{
                    SourceMediaRequest(url,web.url ?: "",downloadAgent ?: web.settings.userAgentString,
                        ProfileStore.getInstance().getProfile(profileName)?.cookieManager?.getCookie(url),"direct")
                }.getOrElse{Toast.makeText(activity,"This download context is unavailable.",Toast.LENGTH_LONG).show();return@setPositiveButton}
                io.execute{try{require(policy.allow(url)&&(!adsEnabled||!app.adFilter.blocks(url)));val name=media?.optString("title")?.let{"$it · Episode $episode"} ?: "Saved episode";app.offline.addSourceDownload(request,name);activity.runOnUiThread{DownloadService.start(activity);Toast.makeText(activity,"Added to Downloads",Toast.LENGTH_SHORT).show()}}catch(_:Exception){activity.runOnUiThread{Toast.makeText(activity,"This download link is unavailable or blocked.",Toast.LENGTH_LONG).show()}}}}.show()
        }
    }

    fun start() {
        if (!isDestroyed) {
            status("Opening source…", if (browserMode) "website" else "loading")
            loadDocument(source.getString("url"))
            handler.postDelayed(probe, 2500)
        }
    }

    fun back() {
        if (!isDestroyed && web.canGoBack()) {
            phase = 3
            selectedUrl = null
            expectDocument(web.copyBackForwardList().let { it.getItemAtIndex(it.currentIndex - 1)?.url })
            web.goBack()
        }
    }

    fun forward() {
        if (!isDestroyed && web.canGoForward()) {
            phase = 3
            selectedUrl = null
            expectDocument(web.copyBackForwardList().let { it.getItemAtIndex(it.currentIndex + 1)?.url })
            web.goForward()
        }
    }

    fun reload() {
        if (isDestroyed) return
        expectDocument(web.url)
        web.reload()
    }

    private fun loadDocument(url: String) {
        expectDocument(url)
        web.loadUrl(url)
    }

    private fun expectDocument(url: String?) {
        invalidateDownload()
        confirmedEpisode=null
        confirmedAudio=null
        pendingDocument = url
        navigationFailed = false
    }

    private fun sameDocument(left: String?, right: String): Boolean {
        if (left == null) return false
        if (left.substringBefore('#') == right.substringBefore('#')) return true
        return runCatching {
            val a = URI(left)
            val b = URI(right)
            fun port(uri: URI) = if (uri.port != -1) uri.port else if (uri.scheme.equals("https", true)) 443 else 80
            a.scheme.equals(b.scheme, true) && a.host.equals(b.host, true) && port(a) == port(b) &&
                a.rawPath.ifEmpty { "/" } == b.rawPath.ifEmpty { "/" } && a.rawQuery == b.rawQuery
        }.getOrDefault(false)
    }

    private fun failNavigation(certificate: Boolean) {
        if (navigationFailed || isDestroyed) return
        navigationFailed = true
        invalidateDownload()
        committed = false
        generation++
        focusTicket++
        focusPending = false
        focused = false
        hideFullscreen()
        if (certificate) onStatus("certificate", "The source page failed the certificate or TLS check.")
        else onStatus("error", "The source page could not be loaded. Retry or choose another source.")
    }

    private fun guard(uri:Uri):WebResourceResponse? {
        if(uri.scheme in setOf("data","blob","about"))return null
        if(adsEnabled&&app.adFilter.blocks(uri.toString()))return WebResourceResponse("text/plain","UTF-8",403,"Blocked",mapOf("Cache-Control" to "no-store"),ByteArrayInputStream(ByteArray(0)))
        return if(policy.allow(uri.toString()))null else WebResourceResponse("text/plain","UTF-8",403,"Blocked",mapOf("Cache-Control" to "no-store"),ByteArrayInputStream(ByteArray(0)))
    }
    private fun intercept(request:WebResourceRequest):WebResourceResponse? {
        val denied=guard(request.url)
        if(denied==null&&request.method.equals("GET",true))mediaCapture.observe(request.url.toString(),request.requestHeaders,downloadEpoch)
        return denied
    }
    private fun installPageObservers(){
        // Fallback keeps main-frame players working on engines without document-start support.
        web.evaluateJavascript(playbackObserver,null)
        if(adsEnabled)web.evaluateJavascript(app.adFilter.script,null)
    }
    private fun invalidateDownload(){
        downloadEpoch++
        mediaCapture.reset(downloadEpoch)
        mediaReports.clear()
        downloadCancel?.invoke()
    }
    private fun receiveMediaReport(packet:String){
        if(isDestroyed||navigationFailed||packet.length>16384)return
        val now=android.os.SystemClock.uptimeMillis()
        if(now-reportWindow>=1000){reportWindow=now;reportCount=0}
        if(++reportCount>64||packet.toByteArray(Charsets.UTF_8).size>16384)return
        runCatching{
            val row=JSONObject(packet);val id=row.optString("id")
            require(id.length in 1..100)
            val urls=row.optJSONArray("resources")
            val frame=PlaybackMediaCapture.Frame(id,row.optString("frameUrl"),row.optString("src"),
                (0 until minOf(urls?.length() ?: 0,16)).map{urls!!.optString(it)},
                row.optDouble("position"),row.optDouble("duration"),row.optInt("width"),row.optInt("height"),
                row.optInt("ready"),row.optBoolean("played"),row.optBoolean("visible"),row.optBoolean("encrypted"))
            mediaReports.entries.removeAll{now-it.value.first>2500}
            if(!mediaReports.containsKey(id)&&mediaReports.size>=64)mediaReports.remove(mediaReports.keys.first())
            mediaReports[id]=now to frame
        }
    }
    /** Read the site's existing controls; its first-group fallback never confirms audio. */
    private fun readAudio(callback:(JSONObject?,Exception?)->Unit){
        if(isDestroyed||navigationFailed){callback(null,IllegalStateException("This source is unavailable."));return}
        val token=generation
        val options=template.replace("__ANIVERSE_PAGE_ARGS__",JSONObject().put("op","siteOptions").put("platform","android").toString())
        val script="""
            (()=>{
              const sheets=document.adoptedStyleSheets,focus=window.__aniverseTabletFocus;
              if(focus)document.adoptedStyleSheets=sheets.filter(s=>s!==focus);
              try{
                const options=$options;
                const active=e=>e&&(/(^|[\s_-])(active|selected|current|is-active|on|checked)($|[\s_-])/i.test(String(e.className))||['aria-pressed','aria-selected','aria-checked','aria-current'].some(a=>/^(true|page)$/.test(e.getAttribute(a)||''))||/^(active|on|checked)$/i.test(e.getAttribute('data-state')||''));
                const rows=(Array.isArray(options)?options:[]).slice(0,40).flatMap(o=>{
                  const value=o.kind==='type'?o.value:o.group;
                  if(!['sub','dub'].includes(value)||!/^av[a-z0-9]{1,90}$/i.test(o.pick||''))return [];
                  const e=document.querySelector('[data-aniverse-pick="'+o.pick+'"]');
                  if(!e)return [];
                  return [{value,pick:o.pick,active:!!(active(e)||(o.kind==='type'&&active(e.parentElement)))}];
                });
                const selected=[...new Set(rows.filter(r=>r.active).map(r=>r.value))];
                return {available:[...new Set(rows.map(r=>r.value))],selected:selected.length===1?selected[0]:null,rows};
              }finally{document.adoptedStyleSheets=sheets}
            })()
        """.trimIndent()
        var done=false
        val timeout=Runnable{if(!done){done=true;callback(null,IllegalStateException("The source audio controls did not respond."))}}
        handler.postDelayed(timeout,5000)
        web.evaluateJavascript(script){raw->
            if(done)return@evaluateJavascript
            done=true;handler.removeCallbacks(timeout)
            if(isDestroyed||token!=generation||navigationFailed){callback(null,IllegalStateException("The source page changed."));return@evaluateJavascript}
            val result=if(raw.length<=32768)runCatching{JSONObject(raw)}.getOrNull() else null
            if(result==null)callback(null,IllegalStateException("The source audio controls are unavailable."))
            else{confirmedAudio=result.optString("selected").takeIf{it in setOf("sub","dub")};callback(result,null)}
        }
    }
    private fun publicAudio(value:JSONObject):JSONObject{
        val observed=value.optJSONArray("available") ?: JSONArray()
        val available=JSONArray()
        for(audio in listOf("sub","dub"))if((0 until minOf(observed.length(),40)).any{observed.optString(it)==audio})available.put(audio)
        return JSONObject().put("available",available).put("selected",confirmedAudio ?: JSONObject.NULL)
    }
    fun audio(value:String?,callback:(JSONObject?,Exception?)->Unit){
        if(value!=null&&value !in setOf("sub","dub")){callback(null,IllegalArgumentException("Choose SUB or DUB."));return}
        if(value!=null&&(media==null||confirmedEpisode!=episode||!sameEpisodePage())){callback(null,IllegalStateException("Open the selected episode before choosing audio."));return}
        if(audioChanging){callback(null,IllegalStateException("The source is changing audio. Please wait."));return}
        readAudio initial@{current,error->
            if(error!=null||current==null){callback(null,error);return@initial}
            if(value==null||confirmedAudio==value){callback(publicAudio(current),null);return@initial}
            val rows=current.optJSONArray("rows") ?: JSONArray()
            val target=(0 until rows.length()).mapNotNull{rows.optJSONObject(it)}.firstOrNull{it.optString("value")==value}
            if(target==null){callback(null,IllegalStateException("This source has not exposed that audio option."));return@initial}
            if(!target.optString("pick").matches(Regex("av[A-Za-z0-9]{1,90}"))){callback(null,IllegalStateException("The source audio control is invalid."));return@initial}
            audioChanging=true;confirmedAudio=null;invalidateDownload()
            val ticket=++audioTicket
            val end=android.os.SystemClock.uptimeMillis()+12000
            fun finish(result:JSONObject?,failure:Exception?){
                if(ticket!=audioTicket)return
                audioChanging=false;callback(result,failure)
            }
            fun poll(){
                if(isDestroyed||navigationFailed){finish(null,IllegalStateException("The source page changed."));return}
                readAudio{observed,_->
                    if(ticket!=audioTicket)return@readAudio
                    if(observed!=null&&confirmedAudio==value&&confirmedEpisode==episode&&sameEpisodePage()){
                        finish(publicAudio(observed),null)
                    }else if(android.os.SystemClock.uptimeMillis()>=end){
                        confirmedAudio=null;finish(null,IllegalStateException("The source did not confirm the requested audio. Use Show website to inspect its controls."))
                    }else handler.postDelayed({poll()},350)
                }
            }
            val packet=JSONObject().put("op","click").put("pick",target.getString("pick")).put("platform","android")
            val click=template.replace("__ANIVERSE_PAGE_ARGS__",packet.toString())
            web.evaluateJavascript("(()=>{const sheets=document.adoptedStyleSheets,focus=window.__aniverseTabletFocus;if(focus)document.adoptedStyleSheets=sheets.filter(s=>s!==focus);try{return "+click+"}finally{document.adoptedStyleSheets=sheets}})()"){clicked->
                if(clicked!="true"){finish(null,IllegalStateException("The source audio control changed. Refresh its options."));return@evaluateJavascript}
                focused=false;focusPending=false;focusTicket++;focusWhenReady()
                handler.postDelayed({poll()},350)
            }
        }
    }
    fun requestDownload(callback:(JSONObject?,Exception?)->Unit){
        if(audioChanging){callback(null,IllegalStateException("Wait for the source to confirm its audio selection."));return}
        readAudio{_,error->if(error!=null)callback(null,error) else requestConfirmedDownload(callback)}
    }
    private fun requestConfirmedDownload(callback:(JSONObject?,Exception?)->Unit){
        if(isDestroyed||navigationFailed||media==null||confirmedEpisode!=episode||!sameEpisodePage()){
            callback(null,IllegalStateException("Open and play the selected episode before downloading."));return
        }
        if(downloadBusy){callback(null,IllegalStateException("This episode is already being prepared for download."));return}
        downloadBusy=true
        val selectedAudio=confirmedAudio
        val token=downloadEpoch
        var done=false
        val publication=PlaybackDownloadOperation()
        lateinit var timeout:Runnable
        fun finish(value:JSONObject?,error:Exception?){
            if(done)return
            done=true;downloadBusy=false;downloadCancel=null;handler.removeCallbacks(timeout)
            val safeError=error?.let{
                IllegalStateException((it.message ?: "The source download could not be prepared.")
                    .replace(Regex("https?://[^\\s]+"),"[private media URL]").take(300))
            }
            callback(value,safeError)
        }
        fun fail(error:Exception){if(publication.cancel())finish(null,error)}
        timeout=Runnable{fail(IllegalStateException("The player did not respond. Keep it playing and retry."))}
        downloadCancel={fail(IllegalStateException("The selected episode changed before download was prepared."))}
        handler.postDelayed(timeout,15000)
        web.evaluateJavascript("window.__aniversePlayingMediaV1 ? window.__aniversePlayingMediaV1.read() : []"){raw->
            if(done)return@evaluateJavascript
            try{
                check(!isDestroyed&&token==downloadEpoch&&confirmedEpisode==episode&&sameEpisodePage()){"The selected episode changed."}
                require(raw.length<=128*1024){"The active player report exceeds its budget."}
                val packets=JSONArray(raw)
                val now=android.os.SystemClock.uptimeMillis()
                val frames=(0 until minOf(packets.length(),16)).mapNotNull{index->
                    val id=packets.optString(index)
                    mediaReports[id]?.takeIf{now-it.first<=2500}?.second
                }
                val plan=mediaCapture.plan(frames,token)
                val cookies=ProfileStore.getInstance().getProfile(profileName)?.cookieManager
                val requests=plan.map{resolved->
                    SourceMediaRequest(resolved.url,resolved.referer,resolved.userAgent.ifBlank{web.settings.userAgentString},
                        cookies?.getCookie(resolved.url),resolved.kind,originHeader=resolved.origin,extraHeaders=resolved.extraHeaders)
                }
                val ownedTitle=(media.optString("title","Episode").take(170)+" · Episode "+episode).take(200)
                io.execute{
                    try{
                        for(request in requests)require(policy.allow(request.url)&&(!adsEnabled||!app.adFilter.blocks(request.url))){"The player media address is blocked."}
                        val request=HlsCaptureResolver.resolve(requests,policy){adsEnabled&&app.adFilter.blocks(it)}.copy(audio=selectedAudio)
                        val value=mediaCapture.commit(token){
                            publication.publish{
                                check(!isDestroyed){"The selected episode was closed."}
                                app.offline.addSourceDownload(request,ownedTitle)
                            }
                        } ?: return@execute
                        // Once published, navigation/timeout cannot abandon an accepted queue item.
                        val started=runCatching{DownloadService.start(activity)}.isSuccess
                        activity.runOnUiThread{
                            finish(JSONObject().put("id",value).put("title",ownedTitle).put("kind",request.kind)
                                .put("started",started).put("audio",request.audio ?: JSONObject.NULL),null)
                        }
                    }catch(error:Exception){activity.runOnUiThread{fail(error)}}
                }
            }catch(error:Exception){fail(error)}
        }
    }
    private fun sameSource(value:String):Boolean=SourceNavigation.sameSource(source.getString("url"),value)
    private fun later(delay:Long, action:()->Unit) {
        val token=generation
        handler.postDelayed({ if(token==generation&&!isDestroyed&&!navigationFailed)action() },delay)
    }
    private fun scheduleAdvance(delay:Long=0) {
        handler.removeCallbacks(advanceTask)
        if(!isDestroyed&&!navigationFailed)handler.postDelayed(advanceTask,delay)
    }
    private fun readEpisodeCards(done:()->Unit) {
        val token=generation
        val packet=JSONObject().put("op","episodeCards").put("slug",JSONObject.NULL)
        web.evaluateJavascript(template.replace("__ANIVERSE_PAGE_ARGS__",packet.toString())) { raw ->
            if(token!=generation||isDestroyed||navigationFailed)return@evaluateJavascript
            val cards=PageResults.episodeCards(raw)
            if(cards.length()>0){episodeCards=cards;episodesKnown=true;status("Finding episode $episode…")}
            done()
        }
    }
    private fun nextQuery():Boolean {
        if(queryIndex+1>=titleQueries.size)return false
        queryIndex++;phase=0;polls=0;titleMisses=0;episodeSteps=0;searchAttempt=0
        method.remove("titleLink");method.remove("episodeLink")
        status("Trying another title name…")
        loadDocument(source.getString("url"))
        return true
    }
    private fun status(value: String, state: String = if (browserMode) "website" else if (focused) "ready" else "loading") {
        if (!navigationFailed || state == "error") onStatus(state, value)
    }
    private fun operation(packet:JSONObject,callback:(JSONObject?)->Unit){
        val token=generation
        if (isDestroyed || navigationFailed) return
        packet.put("platform","android")
        web.evaluateJavascript(template.replace("__ANIVERSE_PAGE_ARGS__",packet.toString())){raw->if(token==generation&&!isDestroyed){val result=PageResults.objectResult(packet.optString("op"),raw);callback(result)}}
    }
    private fun remember(key:String,result:JSONObject?){if(privatePlayback)return;val selector=result?.optString("selector") ?: return;if(selector.isNotBlank()&&selector.length<=300)method.put(key,selector)}
    private fun find(op:String):JSONObject=JSONObject().put("op",op).apply{
        if(op=="findTitle"){put("titles",media?.optJSONArray("titles") ?: org.json.JSONArray().put(media?.optString("title","")));put("season",media?.optInt("season",1) ?: 1);method.optString("titleLink").takeIf{it.isNotBlank()}?.let{put("selector",it)}}
        if(op=="findEpisode"){put("episode",episode);put("slug",JSONObject.NULL);method.optString("episodeLink").takeIf{it.isNotBlank()}?.let{put("selector",it.replace("{n}",episode.toString()))}}
    }
    private fun searchQuery():String=titleQueries.getOrElse(queryIndex){""}
    private fun submitSearch(){
        if(phase!=1||browserMode||isDestroyed||navigationFailed)return
        val token=generation
        // Use the website's ordinary form action first; not every WebView exposes an IME connection.
        web.evaluateJavascript("""
            (() => {
              const input=document.activeElement;
              if(!(input instanceof HTMLInputElement)||input.disabled)return false;
              if(!input.form){
                for(let parent=input.parentElement,depth=0;parent&&depth<2;parent=parent.parentElement,depth++){
                  const button=[...parent.querySelectorAll('button,[role="button"]')].find(el=>{
                    const rect=el.getBoundingClientRect(),style=getComputedStyle(el);
                    const label=(el.getAttribute('aria-label')||el.textContent||'').trim();
                    return !el.disabled&&rect.width>0&&rect.height>0&&style.visibility==='visible'&&style.display!=='none'&&
                      /^(search|find)(?:\s+(anime|titles?))?$/i.test(label);
                  });
                  if(button){button.click();return true;}
                }
                return false;
              }
              const form=input.form;
              if(typeof form.requestSubmit==='function')form.requestSubmit();
              else if(form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
                HTMLFormElement.prototype.submit.call(form);
              return true;
            })()
        """.trimIndent()) { submitted ->
            if(token!=generation||phase!=1||isDestroyed||navigationFailed)return@evaluateJavascript
            if(!browserMode&&submitted!="true")submitNativeSearch()
            searchBusy=false
            scheduleAdvance(300)
        }
    }
    private fun submitNativeSearch(){
        web.requestFocus()
        val info=android.view.inputmethod.EditorInfo();val connection=web.onCreateInputConnection(info)
        val action=info.imeOptions and android.view.inputmethod.EditorInfo.IME_MASK_ACTION
        val handled=if(connection!=null&&action in setOf(android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH,android.view.inputmethod.EditorInfo.IME_ACTION_GO,android.view.inputmethod.EditorInfo.IME_ACTION_DONE))connection.performEditorAction(action) else false
        if(!handled){web.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_ENTER));web.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP,KeyEvent.KEYCODE_ENTER))}
    }
    private fun advance(){
        if (isDestroyed || navigationFailed || media == null || browserMode || phase == 3 || !committed || advanceBusy || searchBusy) return
        if (polls++ > 45) {
            if(nextQuery())return
            status("Could not find the episode. Open the website to choose it.", if (browserMode) "website" else "needs-site")
            return
        }
        when(phase){
            0->{
                if(searchBusy)return
                val template=method.optString("searchTemplate").ifBlank{source.optString("searchTemplate")}
                if(template.contains("{query}")){val url=template.replace("{query}",java.net.URLEncoder.encode(searchQuery(),"UTF-8"));if(sameSource(url)){phase=1;loadDocument(url);return}}
                searchBusy=true
                val now=android.os.SystemClock.uptimeMillis()
                if(searchOpeningUntil>0&&now>=searchOpeningUntil){
                    // A successful .click() does not prove the opener actually produced a search field.
                    method.remove("searchOpener")
                    searchOpeningUntil=0L
                }
                val opening=now<searchOpeningUntil
                operation(JSONObject().put("op","openSearch").put("attempt",if(opening)-1 else searchAttempt).put("selector",method.optString("searchOpener"))){opened->
                    if(opened?.optBoolean("input")==true){
                        searchOpeningUntil=0L
                        web.requestFocus()
                        operation(JSONObject().put("op","fillSearch").put("query",searchQuery()).put("selector",method.optString("searchInput"))){filled->
                            searchBusy=false
                            if(filled?.optBoolean("ok")==true){remember("searchInput",filled);phase=1;titleMisses=0;searchBusy=true;status("Searching for the series…");submitSearch()}
                            else scheduleAdvance(250)
                        }
                    }else{
                        if(opening){later(250){searchBusy=false;scheduleAdvance()};return@operation}
                        if(opened?.optBoolean("clicked")==true)searchOpeningUntil=android.os.SystemClock.uptimeMillis()+1800
                        if(method.has("searchOpener")&&opened?.optBoolean("clicked")!=true)method.remove("searchOpener")
                        remember("searchOpener",opened?.takeIf{it.optBoolean("clicked")})
                        searchAttempt=if(opened?.optBoolean("more")==true)(searchAttempt+1).coerceAtMost(3) else 0
                        later(300){searchBusy=false;scheduleAdvance()}
                    }
                }
            }
            1->{
                advanceBusy=true
                operation(find("findTitle")){pick->
                    advanceBusy=false
                    if(pick!=null){remember("titleLink",pick);phase=2;follow(pick)}
                    else {
                        method.remove("titleLink")
                        if(++titleMisses>=10){
                            if(nextQuery())return@operation
                            if(method.has("searchTemplate")){method.remove("searchTemplate");phase=0;titleMisses=0}
                        }
                        scheduleAdvance(400)
                    }
                }
            }
            2->{
                advanceBusy=true
                if(episodeCardsGeneration!=generation){
                    episodeCardsGeneration=generation
                    readEpisodeCards { advanceBusy=false;scheduleAdvance() }
                    return
                }
                operation(find("findEpisode")){pick->
                    advanceBusy=false
                    if (pick != null) {
                        remember("episodeLink", pick)
                        phase = 3
                        selectedUrl = sourceLink(pick)
                        follow(pick)
                        status("Loading episode $episode…")
                        later(250){ focusWhenReady() }
                    }
                    else if(method.has("episodeLink")){method.remove("episodeLink");scheduleAdvance(100)}
                    else if(episodeSteps++==0)operation(JSONObject().put("op","episodesTab")){episodeCardsGeneration=-1;scheduleAdvance(250)}
                    else if(episodeSteps==2)operation(JSONObject().put("op","watchLink").put("slug",JSONObject.NULL)){watch->if(watch!=null)follow(watch) else scheduleAdvance(300)}
                    else scheduleAdvance(400)
                }
            }
        }
    }
    private fun sourceLink(pick: JSONObject): String? =
        (pick.opt("href") as? String)?.takeIf(::sameSource)

    private fun follow(pick: JSONObject) {
        if(browserMode||isDestroyed||navigationFailed)return
        val href = sourceLink(pick)
        if (href != null) {
            if (web.url != href) loadDocument(href)
            else scheduleAdvance(100)
            return
        }
        val key = pick.opt("pick") as? String
        if (key != null && key.matches(Regex("[A-Za-z0-9_-]{1,100}"))) {
            operation(JSONObject().put("op", "click").put("pick", key)) {
                scheduleAdvance(250)
                later(250){focusWhenReady()}
            }
        } else status("Choose the episode on the website", "needs-site")
    }

    private fun saveMethod(){if(privatePlayback)return;method.put("version",1).put("origin",NetworkPolicy.origin(URI(source.getString("url")))).put("at",System.currentTimeMillis());preferences.edit().putString(source.getString("id"),method.toString()).apply()}
    private fun sameEpisodePage(currentUrl:String?=web.url): Boolean {
        val current = currentUrl ?: return false
        val selected = selectedUrl ?: return false
        if (!sameSource(current)) return false
        return runCatching {
            val actual = URI(current)
            val target = URI(selected)
            actual.rawPath.trimEnd('/') == target.rawPath.trimEnd('/') &&
                actual.rawQuery == target.rawQuery && actual.rawFragment == target.rawFragment
        }.getOrDefault(false)
    }

    private fun confirmEpisode(ticket: Int, callback: (Boolean) -> Unit) {
        if (sameEpisodePage()) {
            callback(true)
            return
        }
        val url = web.url
        if (url == null || !sameSource(url) || media == null) {
            callback(false)
            return
        }
        // Some episode cards route through a click or canonicalize the link after navigation.
        operation(JSONObject().put("op", "episodeCheck").put("episode", episode)) { result ->
            if (ticket != focusTicket) return@operation
            if (result?.optBoolean("matches") != true) {
                callback(false)
            } else {
                val check = JSONObject().put("op", "titleCheck").put("titles", media.optJSONArray("titles"))
                    .put("season", media.optInt("season", 1))
                operation(check) titleCheck@{ title ->
                    if (ticket != focusTicket) return@titleCheck
                    val confirmed = web.url == url && (title?.optDouble("score") ?: 0.0) >= 0.72
                    if (confirmed) selectedUrl = url
                    callback(confirmed)
                }
            }
        }
    }

    private fun focusWhenReady(manual: Boolean = false) {
        if (isDestroyed || navigationFailed || focused || focusPending || browserMode) return
        if (!manual && (media == null || phase != 3)) return
        focusPending = true
        val ticket = ++focusTicket
        val deadline = android.os.SystemClock.uptimeMillis() + 25_000
        fun attempt() {
            if (isDestroyed || ticket != focusTicket || browserMode) return
            fun retry() {
                if (android.os.SystemClock.uptimeMillis() >= deadline) {
                    focusPending = false
                    status("Player is still loading. Retry or open the website.", "needs-site")
                } else handler.postDelayed({ attempt() }, 500)
            }
            if (!committed) {
                retry()
                return
            }
            fun mark() {
                operation(JSONObject().put("op", "markPlayer").put("keep", true)) { result ->
                    if (ticket != focusTicket) return@operation
                    if (result?.optBoolean("found") != true) {
                        retry()
                        return@operation
                    }
                    // CSSOM creates the presentation rules without an inline <style> tag.
                    // Confirm the rules changed layout before showing the website surface.
                    web.evaluateJavascript("""
                        (() => {
                          const old = window.__aniverseTabletFocus;
                          if (!old || !document.adoptedStyleSheets.includes(old)) {
                            const sheet = new CSSStyleSheet();
                            sheet.replaceSync(${JSONObject.quote(focusCss)});
                            document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
                            window.__aniverseTabletFocus = sheet;
                          }
                          const player = document.querySelector('[data-aniverse-player]');
                          if (!player || getComputedStyle(player).position !== 'fixed') return false;
                          const rect = player.getBoundingClientRect();
                          return Math.abs(rect.left) < 2 && Math.abs(rect.top) < 2 &&
                            Math.abs(rect.width - innerWidth) < 3 && Math.abs(rect.height - innerHeight) < 3;
                        })()
                    """.trimIndent()) { applied ->
                        if (ticket != focusTicket || isDestroyed) return@evaluateJavascript
                        if (applied == "true") {
                            focused = true
                            focusPending = false
                            if (!manual) saveMethod()
                            status(if (media == null) "Player only" else "Episode $episode", "ready")
                        } else {
                            retry()
                        }
                    }
                }
            }
            if (manual) mark()
            else confirmEpisode(ticket) { matches ->
                if (matches) { confirmedEpisode=episode;mark() } else retry()
            }
        }
        attempt()
    }

    fun showWebsite() {
        if (isDestroyed || navigationFailed) return
        browserMode = true
        handler.removeCallbacks(advanceTask)
        focused = false
        focusTicket++
        focusPending = false
        operation(JSONObject().put("op", "releasePlayer")) {}
        web.evaluateJavascript("""
            document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== window.__aniverseTabletFocus);
            delete window.__aniverseTabletFocus;
        """.trimIndent()) {
            if (!isDestroyed && browserMode) status("Website view", "website")
        }
    }

    fun showPlayer() {
        if (isDestroyed || navigationFailed) return
        browserMode = false
        status("Finding the player…", "loading")
        focusWhenReady(manual = true)
    }

    fun toggleFocus() {
        if (focused) showWebsite() else showPlayer()
    }

    private fun captureProgress(){
        if(isDestroyed||navigationFailed||privatePlayback||media==null||phase!=3||!sameEpisodePage())return
        val token=generation;val currentEpisode=episode;val currentUrl=selectedUrl;val snapshot=media!!
        web.evaluateJavascript("(()=>{const v=document.querySelector('video');return v&&Number.isFinite(v.currentTime)&&Number.isFinite(v.duration)&&v.duration>0?{position:v.currentTime,duration:v.duration}:null})()"){raw->runCatching{val result=JSONObject(raw);val position=result.getDouble("position");val duration=result.getDouble("duration");if(token==generation&&currentEpisode==episode&&currentUrl==selectedUrl&&sameEpisodePage()&&position.isFinite()&&duration.isFinite()&&duration>0)MainActivity.progress(snapshot,currentEpisode,source.getString("id"),position.coerceAtLeast(0.0),duration)}}
    }
    fun hideFullscreen(): Boolean {
        val fullscreen = customView ?: return false
        (fullscreen.parent as? ViewGroup)?.removeView(fullscreen)
        customView = null
        fullscreenCallback?.onCustomViewHidden()
        fullscreenCallback = null
        activity.window.insetsController?.show(android.view.WindowInsets.Type.systemBars())
        return true
    }

    fun pause() { if (!isDestroyed) web.onPause() }
    fun resume() { if (!isDestroyed) web.onResume() }

    fun close() {
        if (closed) return
        closed = true
        invalidateDownload()
        handler.removeCallbacksAndMessages(null)
        hideFullscreen()
        if (!rendererGone) {
            (web.parent as? ViewGroup)?.removeView(web)
            web.stopLoading()
            web.destroy()
        }
        if (privatePlayback) runCatching {
            val profile = ProfileStore.getInstance().getProfile(profileName)
            profile?.cookieManager?.removeAllCookies(null)
            profile?.webStorage?.deleteAllData()
            ProfileStore.getInstance().deleteProfile(profileName)
        }
        policy.close()
        io.shutdownNow()
    }
}
