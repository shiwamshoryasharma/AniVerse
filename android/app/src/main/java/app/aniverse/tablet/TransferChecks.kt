package app.aniverse.tablet
/** Validate HTTP transfer metadata before reading or appending any response bytes. */
object TransferChecks {
    const val MAX_FILE_BYTES=64L*1024*1024*1024
    data class Plan(val offset:Long,val total:Long)
    fun validate(status:Int,range:String?,length:Long,offset:Long,oldTotal:Long,oldTag:String,tag:String):Plan {
        require(status==200||status==206){"Download server returned HTTP $status. Retry or choose a fresh file link."}
        if(status==200){require(length<=MAX_FILE_BYTES){"This video exceeds the 64 GiB download budget."};return Plan(0,length.coerceAtLeast(0))}
        val match=Regex("bytes (\\d+)-(\\d+)/(\\d+)").matchEntire(range ?: "") ?: throw IllegalArgumentException("The server sent an invalid byte range.")
        val start=match.groupValues[1].toLong();val end=match.groupValues[2].toLong();val total=match.groupValues[3].toLong()
        require(total<=MAX_FILE_BYTES&&start==offset&&end>=start&&end<total&&(length<0||length==end-start+1)){"Resume range did not match the saved file. Restart this download."}
        require(oldTotal<=0||offset==0L||oldTotal==total){"The remote file changed. Restart this download."}
        require(offset==0L||oldTag.isBlank()||tag.isBlank()||oldTag==tag){"The remote file changed. Restart this download."}
        return Plan(offset,total)
    }
}
