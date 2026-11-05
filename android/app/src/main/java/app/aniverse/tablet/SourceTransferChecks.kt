package app.aniverse.tablet

/** Per-episode budgets apply to all manifest, key, segment and ignored-range reads. */
internal class SourceTransferBudget(private val maximum:Long=TransferChecks.MAX_FILE_BYTES,initial:Long=0,private val maximumRequests:Int=40000){
    private var bytes=initial
    private var requests=0
    init{require(initial>=0&&initial<=maximum&&maximumRequests>0)}
    @Synchronized fun request(){require(requests<maximumRequests){"The source requested too many media resources."};requests++}
    @Synchronized fun read(count:Int){require(count>=0&&count.toLong()<=maximum-bytes){"This source episode exceeds the download budget."};bytes+=count}
}
internal object SourceRanges {
    data class Plan(val skip:Long,val length:Long)
    fun validate(status:Int,range:String?,length:Long,position:Long,requested:Long):Plan{
        require(position in 0..TransferChecks.MAX_FILE_BYTES&&requested in -1..TransferChecks.MAX_FILE_BYTES)
        require(length in -1..TransferChecks.MAX_FILE_BYTES)
        if(status==206){
            val match=Regex("^bytes ([0-9]+)-([0-9]+)/([0-9]+|\\*)$").matchEntire(range ?: "")
                ?: throw IllegalArgumentException("The source sent an invalid byte range.")
            val start=match.groupValues[1].toLongOrNull() ?: error("Invalid source range.")
            val end=match.groupValues[2].toLongOrNull() ?: error("Invalid source range.")
            require(start==position&&end>=start&&end<TransferChecks.MAX_FILE_BYTES){"The source returned the wrong saved offset."}
            val bytes=end-start+1
            require(length==-1L||length==bytes){"The source range length is inconsistent."}
            require(requested==-1L||bytes<=requested){"The source exceeded its requested byte range."}
            if(match.groupValues[3]!="*"){
                val total=match.groupValues[3].toLongOrNull() ?: error("Invalid source size.")
                require(total>end&&total<=TransferChecks.MAX_FILE_BYTES){"The source range has an invalid total size."}
            }
            return Plan(0,bytes)
        }
        require(status==200){"Source media server returned HTTP $status."}
        require(length==-1L||position<=length){"The source ended before its saved offset."}
        val available=if(length<0)-1 else length-position
        val expected=if(requested<0)available else if(available<0)requested else minOf(requested,available)
        return Plan(position,expected)
    }
}
