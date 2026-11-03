package app.aniverse.tablet

/** Same text-only SRT -> WebVTT normalization as the desktop subtitle boundary. */
object SubtitleText {
    fun toVtt(input:String):String {
        require(input.length<=4*1024*1024&&!input.contains('\u0000')){"Choose a UTF-8 SRT or WebVTT subtitle file."}
        val text=input.removePrefix("\uFEFF").replace("\r\n","\n").replace('\r','\n').trim()
        require(Regex("\\d{1,2}:\\d{2}(?::\\d{2})?[.,]\\d{3}\\s+-->\\s+\\d{1,2}:\\d{2}(?::\\d{2})?[.,]\\d{3}").containsMatchIn(text)){"Choose a valid SRT or WebVTT subtitle file."}
        if(Regex("^WEBVTT(?:\\s|$)").containsMatchIn(text))return text+"\n"
        return "WEBVTT\n\n"+Regex("(\\d{2}:\\d{2}:\\d{2}),(\\d{3})").replace(text,"$1.$2")+"\n"
    }
}
