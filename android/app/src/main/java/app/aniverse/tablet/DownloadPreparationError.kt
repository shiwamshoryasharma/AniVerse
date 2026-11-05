package app.aniverse.tablet

import java.net.SocketTimeoutException
import java.util.concurrent.TimeoutException
import java.util.Locale

/** Keep transport internals and source addresses out of the download action's public errors. */
internal object DownloadPreparationError {
    private const val TIMEOUT="The source took too long to prepare this download. Keep the episode playing and try Download again."
    fun message(error:Throwable):String {
        var cause:Throwable?=error
        repeat(8){
            val current=cause ?: return@repeat
            if(current is SocketTimeoutException||current is TimeoutException)return TIMEOUT
            cause=current.cause
        }
        val message=error.message?.trim().takeUnless{it.isNullOrEmpty()} ?: "The source download could not be prepared."
        if(message.lowercase(Locale.ROOT) in setOf("timeout","timed out","read timed out","connect timed out","connection timed out"))return TIMEOUT
        return message.replace(Regex("https?://[^\\s]+"),"[private media URL]").take(300)
    }
}
