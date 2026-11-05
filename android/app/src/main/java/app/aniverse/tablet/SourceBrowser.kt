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
import org.json.JSONObject
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
    private val policy = NetworkPolicy(if (BuildConfig.DEBUG) BuildConfig.TEST_ORIGIN else "")
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
        profile.serviceWorkerController.setServiceWorkerClient(object:ServiceWorkerClient(){override fun shouldInterceptRequest(request:WebResourceRequest):WebResourceResponse?=guard(request.url)})
        web.settings.apply{javaScriptEnabled=true;domStorageEnabled=true;allowFileAccess=false;allowContentAccess=false;setSupportMultipleWindows(true);javaScriptCanOpenWindowsAutomatically=false;mixedContentMode=WebSettings.MIXED_CONTENT_NEVER_ALLOW;safeBrowsingEnabled=true;mediaPlaybackRequiresUserGesture=true;if(privatePlayback)cacheMode=WebSettings.LOAD_NO_CACHE}
        web.webViewClient=object:WebViewClient(){
            override fun shouldInterceptRequest(view:WebView,request:WebResourceRequest):WebResourceResponse?=guard(request.url)
            override fun shouldOverrideUrlLoading(view:WebView,request:WebResourceRequest):Boolean {
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
                confirmedEpisode=null
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
                if(!privatePlayback&&phase==1&&sameSource(url)){val query=searchQuery();if(query.isNotBlank()){val encoded=java.net.URLEncoder.encode(query,"UTF-8");for(value in listOf(encoded,encoded.replace("+","%20"),query))if(url.contains(value)){method.put("searchTemplate",url.replace(value,"{query}"));break}}}
                status(if(media==null)"Browser" else if(phase==3)"Loading episode $episode…" else if(phase==2)"Finding episode $episode…" else "Finding the series…");scheduleAdvance(80);later(80){focusWhenReady()}}
            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                if(confirmedEpisode!=null&&!sameEpisodePage(url)){
                    confirmedEpisode=null
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
        web.webChromeClient=object:WebChromeClient(){
            override fun onCreateWindow(view:WebView,isDialog:Boolean,isUserGesture:Boolean,resultMsg:android.os.Message)=false
            override fun onPermissionRequest(request:PermissionRequest){request.deny()}
            override fun onGeolocationPermissionsShowPrompt(origin:String,callback:GeolocationPermissions.Callback){callback.invoke(origin,false,false)}
            override fun onShowFileChooser(view:WebView,callback:ValueCallback<Array<Uri>>,params:FileChooserParams)=false
            override fun onShowCustomView(view:View,callback:CustomViewCallback){if(customView!=null||!web.isShown||web.alpha==0f){callback.onCustomViewHidden();return};customView=view;fullscreenCallback=callback;activity.addContentView(view,ViewGroup.LayoutParams(-1,-1));activity.window.insetsController?.hide(android.view.WindowInsets.Type.systemBars())}
            override fun onHideCustomView(){hideFullscreen()}
        }
        web.setDownloadListener{url,_,_,mime,_->
            if(mime?.startsWith("video/")==true||mime=="application/octet-stream")AlertDialog.Builder(activity).setTitle("Save for Local watch?").setMessage("Save this direct video-file link in the app's private storage. Downloads remain on this device until removed, including when started during private browsing.").setNegativeButton("Cancel",null).setPositiveButton("Download"){_,_->io.execute{try{require(policy.allow(url));val name=media?.optString("title")?.let{"$it · Episode $episode"} ?: "Saved episode";app.offline.addDownload(url,name);activity.runOnUiThread{DownloadService.start(activity);Toast.makeText(activity,"Added to Downloads",Toast.LENGTH_SHORT).show()}}catch(_:Exception){activity.runOnUiThread{Toast.makeText(activity,"This download link is unavailable or blocked.",Toast.LENGTH_LONG).show()}}}}.show()
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
        confirmedEpisode=null
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
        return if(policy.allow(uri.toString()))null else WebResourceResponse("text/plain","UTF-8",403,"Blocked",mapOf("Cache-Control" to "no-store"),ByteArrayInputStream(ByteArray(0)))
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
