package app.aniverse.tablet

import android.graphics.Rect
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.webkit.WebView
import android.widget.FrameLayout
import org.json.JSONObject
import kotlin.math.roundToInt

/** Native sibling of the trusted UI WebView. It only covers the visible player slot. */
internal class SourcePane(
    private val activity: MainActivity,
    private val host: FrameLayout,
    private val shell: WebView
) {
    private var session: String? = null
    private var browser: SourceBrowser? = null
    private var presentable = false
    private var visibleBounds = false
    private var ownsSecureFlag = false
    private val surface = object : FrameLayout(activity) {
        override fun dispatchTouchEvent(event: android.view.MotionEvent): Boolean {
            return presentable && super.dispatchTouchEvent(event)
        }
    }.apply {
        visibility = View.INVISIBLE
        clipChildren = true
    }

    fun begin(id: String) {
        close()
        session = id
    }

    fun attach(id: String, source: JSONObject, media: JSONObject, episode: Int, privatePlayback: Boolean): Boolean {
        if (session != id || activity.isDestroyed) return false
        val owned = SourceBrowser(activity, source, media, episode, privatePlayback) { state, message ->
            if (session == id) {
                presentable = state == "ready" || state == "website"
                updateVisibility()
                val detail = JSONObject().put("session", id).put("state", state).put("message", message)
                    .put("episodes", browser?.episodeCards ?: org.json.JSONArray())
                    .put("episodesKnown", browser?.episodesKnown == true)
                    .put("confirmedEpisode",browser?.confirmedEpisode ?: JSONObject.NULL)
                shell.evaluateJavascript("window.dispatchEvent(new CustomEvent('tablet-playback',{detail:$detail}))", null)
            }
        }
        browser = owned
        if (privatePlayback && activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE == 0) {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            ownsSecureFlag = true
        }
        surface.addView(owned.web,FrameLayout.LayoutParams(-1, -1))
        host.addView(surface, FrameLayout.LayoutParams(1, 1))
        owned.start()
        return true
    }

    fun place(id: String, input: JSONObject) {
        if (session != id) return
        val player = browser?.web ?: return
        visibleBounds = false
        val viewportWidth = input.optDouble("viewportWidth")
        val scale = shell.width / viewportWidth
        if (!input.optBoolean("visible") || !scale.isFinite() || scale <= 0 || shell.width == 0 || shell.height == 0) {
            updateVisibility()
            return
        }
        fun coordinate(key: String): Int {
            val value = input.getDouble(key) * scale
            require(value.isFinite() && value in -32000.0..32000.0)
            return value.roundToInt()
        }
        val slot = Rect(coordinate("left"), coordinate("top"), coordinate("right"), coordinate("bottom"))
        val clip = Rect(coordinate("clipLeft"), coordinate("clipTop"), coordinate("clipRight"), coordinate("clipBottom"))
        if (slot.width() <= 0 || slot.height() <= 0 || slot.width() > shell.width ||
            slot.height() > shell.height || !clip.intersect(slot) ||
            !clip.intersect(0, 0, shell.width, shell.height)
        ) {
            updateVisibility()
            return
        }
        surface.layoutParams = FrameLayout.LayoutParams(clip.width(), clip.height(), Gravity.TOP or Gravity.LEFT).apply {
            leftMargin = clip.left
            topMargin = clip.top
        }
        player.layoutParams = FrameLayout.LayoutParams(slot.width(), slot.height(), Gravity.TOP or Gravity.LEFT).apply {
            leftMargin = slot.left - clip.left
            topMargin = slot.top - clip.top
        }
        visibleBounds = true
        updateVisibility()
    }

    private fun updateVisibility() {
        surface.visibility = if (visibleBounds) View.VISIBLE else View.INVISIBLE
        surface.importantForAccessibility = if (presentable) View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
            else View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        browser?.web?.alpha = if (presentable) 1f else 0f
    }

    fun action(id: String, action: String) {
        if (session != id) return
        when (action) {
            "website" -> browser?.showWebsite()
            "player" -> browser?.showPlayer()
            "back" -> browser?.back()
            "forward" -> browser?.forward()
            else -> error("Unknown playback action.")
        }
    }

    fun audio(id:String,value:String?,callback:(JSONObject?,Exception?)->Unit){
        val owned=browser
        if(session!=id||owned==null){callback(null,IllegalStateException("This player session is no longer active."));return}
        owned.audio(value){result,error->
            if(session==id&&browser===owned)callback(result,error)
            else callback(null,IllegalStateException("The selected player changed."))
        }
    }
    fun requestDownload(id:String,callback:(JSONObject?,Exception?)->Unit){
        val owned=browser
        if(session!=id||owned==null){callback(null,IllegalStateException("This player session is no longer active."));return}
        owned.requestDownload { value,error->
            if(value!=null||(session==id&&browser===owned))callback(value,error)
            else callback(null,IllegalStateException("The selected player changed."))
        }
    }
    @Suppress("UNUSED_PARAMETER")
    fun requestDownload(id:String,title:String,callback:(JSONObject?,Exception?)->Unit)=requestDownload(id,callback)

    fun hideFullscreen() = browser?.hideFullscreen() == true
    fun pause() { browser?.pause() }
    fun resume() { browser?.resume() }

    fun close(id: String? = null) {
        if (id != null && session != id) return
        session = null
        browser?.close()
        browser = null
        host.removeView(surface)
        presentable = false
        visibleBounds = false
        updateVisibility()
        if (ownsSecureFlag) activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        ownsSecureFlag = false
    }
}
