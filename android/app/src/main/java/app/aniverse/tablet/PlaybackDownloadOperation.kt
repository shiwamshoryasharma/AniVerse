package app.aniverse.tablet

/** Publication is atomic with cancellation; timeout cannot turn an accepted queue item into a failed action. */
internal class PlaybackDownloadOperation {
    private enum class State { ACTIVE, CANCELLED, PUBLISHED }
    private var state=State.ACTIVE
    @Synchronized fun cancel():Boolean {
        if(state!=State.ACTIVE)return false
        state=State.CANCELLED
        return true
    }
    @Synchronized fun <T> publish(work:()->T):T? {
        if(state!=State.ACTIVE)return null
        val result=work()
        state=State.PUBLISHED
        return result
    }
}
