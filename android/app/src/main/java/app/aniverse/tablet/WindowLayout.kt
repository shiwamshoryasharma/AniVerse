package app.aniverse.tablet

/** A window size describes layout space; it never decides whether the device may launch. */
internal data class WindowLayout(val widthDp:Int,val heightDp:Int){
    val widthClass:String get()=when{widthDp<600->"compact";widthDp<840->"medium";else->"expanded"}
    val heightClass:String get()=when{heightDp<480->"compact";heightDp<900->"medium";else->"expanded"}
    companion object{
        fun pixels(width:Int,height:Int,density:Float):WindowLayout{
            require(width>0&&height>0&&density.isFinite()&&density>0)
            return WindowLayout((width/density).toInt().coerceAtLeast(1),(height/density).toInt().coerceAtLeast(1))
        }
    }
}
