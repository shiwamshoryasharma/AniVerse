package app.aniverse.tablet

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject

/** Full website browsing from the Sources screen. Episode playback uses the inline pane. */
class SourceActivity : Activity() {
    private var browser: SourceBrowser? = null

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val source = JSONObject(intent.getStringExtra("source") ?: return finish())
        val privatePlayback = intent.getBooleanExtra("private", false)
        if (privatePlayback) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(17, 12, 23))
            keepSystemInsets()
        }
        val title = TextView(this).apply {
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER_VERTICAL
            maxLines = 2
        }
        val view = SourceBrowser(this, source, null, 1, privatePlayback) { _, status ->
            title.text = source.optString("name") + " · " + status + if (privatePlayback) " · Private" else ""
        }
        browser = view
        val toolbar = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        toolbar.addView(button("‹", "Back", view::back))
        toolbar.addView(button("›", "Forward", view::forward))
        toolbar.addView(button("↻", "Reload source", view::reload))
        toolbar.addView(title, LinearLayout.LayoutParams(0, dp(52), 1f))
        toolbar.addView(button("Focus", "Toggle original player focus", view::toggleFocus))
        toolbar.addView(button("Done", "Close source browser", ::finish))
        root.addView(toolbar, LinearLayout.LayoutParams(-1, dp(56)))
        root.addView(view.web, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
        onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) {
            if (!view.hideFullscreen()) finish()
        }
        view.start()
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun button(label: String, description: String, action: () -> Unit) = Button(this).apply {
        text = label
        contentDescription = description
        minWidth = dp(48)
        minHeight = dp(48)
        setTextColor(Color.rgb(255, 183, 117))
        setBackgroundColor(Color.TRANSPARENT)
        setOnClickListener { action() }
    }

    override fun onPause() { browser?.pause(); super.onPause() }
    override fun onResume() { super.onResume(); browser?.resume() }
    override fun onDestroy() { browser?.close(); super.onDestroy() }
}
