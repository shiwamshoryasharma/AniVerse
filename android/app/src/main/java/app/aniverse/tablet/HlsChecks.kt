package app.aniverse.tablet

/** Reject live/DRM playlists before Media3 caches or downloads their segments. */
internal object HlsChecks {
    const val MAX_PLAYLIST_BYTES=2*1024*1024
    fun validate(bytes:ByteArray) {
        require(bytes.size<=MAX_PLAYLIST_BYTES){"The source playlist is too large."}
        val text=Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .decode(java.nio.ByteBuffer.wrap(bytes)).toString().removePrefix("\uFEFF")
        require(text.trimStart().startsWith("#EXTM3U")){"The source returned a webpage instead of its video playlist. Tap Retry, resume playback, then Download to capture a fresh link."}
        val lines=text.lineSequence().map{it.trim()}.toList()
        require(lines.size<=40000){"The source playlist has too many entries."}
        require(lines.count{it.startsWith("#EXTINF:")}<=20000){"The source playlist has too many segments."}
        for(line in lines.filter{it.startsWith("#EXT-X-KEY:")||it.startsWith("#EXT-X-SESSION-KEY:")}){
            val method=Regex("(?:^|,)METHOD=([^,]+)").find(line.substringAfter(':'))?.groupValues?.get(1)
            val format=Regex("(?:^|,)KEYFORMAT=\"([^\"]+)\"").find(line.substringAfter(':'))?.groupValues?.get(1)
            require(!line.contains("KEYFORMAT=")||format!=null){"The source key format is invalid."}
            require(method in setOf("NONE","AES-128")&&(format==null||format=="identity")){"DRM-protected or unsupported encrypted streams cannot be saved."}
        }
        if(lines.any{it.startsWith("#EXTINF:")})
            require(lines.any{it=="#EXT-X-ENDLIST"}){"Live streams cannot be saved as complete offline episodes."}
        else require(lines.any{it.startsWith("#EXT-X-STREAM-INF:")||it.startsWith("#EXT-X-MEDIA:")}){"The source playlist has no media."}
    }
    /** Register opaque master child playlist addresses before any parser requests them. */
    fun playlistUris(bytes:ByteArray,base:String):List<String>{
        validate(bytes)
        val lines=String(bytes,Charsets.UTF_8).removePrefix("\uFEFF").lineSequence().map{it.trim()}.toList()
        val result=mutableListOf<String>();var nextVariant=false
        fun add(value:String){
            require(value.length<=8192&&value.none{it.code<32||it.code==127})
            val uri=java.net.URI(base).resolve(value)
            require(uri.scheme in setOf("http","https")&&uri.host!=null&&uri.rawUserInfo==null){"The source playlist has an unsafe child address."}
            result.add(uri.toString())
        }
        for(line in lines){
            if(line.startsWith("#EXT-X-STREAM-INF:"))nextVariant=true
            else if(line.startsWith("#EXT-X-MEDIA:")||line.startsWith("#EXT-X-I-FRAME-STREAM-INF:")){
                Regex("(?:^|,)URI=\"([^\"]+)\"").find(line.substringAfter(':'))?.groupValues?.get(1)?.let(::add)
            }else if(line.isNotEmpty()&&!line.startsWith("#")&&nextVariant){add(line);nextVariant=false}
        }
        return result.distinct()
    }

}
