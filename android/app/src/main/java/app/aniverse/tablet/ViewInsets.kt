package app.aniverse.tablet

import android.view.View
import android.view.WindowInsets

/** Keep controls clear of Android 15's enforced edge-to-edge system bars and cutouts. */
internal fun View.keepSystemInsets() {
    val left=paddingLeft;val top=paddingTop;val right=paddingRight;val bottom=paddingBottom
    setOnApplyWindowInsetsListener { view,insets ->
        val bars=insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
        view.setPadding(left+bars.left,top+bars.top,right+bars.right,bottom+bars.bottom)
        insets
    }
    requestApplyInsets()
}
