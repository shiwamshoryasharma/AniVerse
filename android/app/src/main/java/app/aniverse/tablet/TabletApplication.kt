package app.aniverse.tablet
import android.app.Application
class TabletApplication : Application() {
    lateinit var store: AppStore
    lateinit var offline: OfflineStore
    internal val adFilter by lazy { AdFilter(this) }
    @Volatile var incognito = false
    override fun onCreate() { super.onCreate(); store = AppStore(this); offline = OfflineStore(this); offline.pauseInterrupted(); offline.recoverStorage() }
}
