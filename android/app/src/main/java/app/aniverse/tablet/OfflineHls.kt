package app.aniverse.tablet

import android.content.Context
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.PlaceholderDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.NoOpCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import java.io.File

/** A private cache per saved episode; offline playback has no HTTP upstream. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
internal class OfflineHls(private val context:Context,directory:File):AutoCloseable {
    private val database=StandaloneDatabaseProvider(context)
    val cache=SimpleCache(directory,NoOpCacheEvictor(),database)
    fun downloading(upstream:DataSource.Factory)=CacheDataSource.Factory().setCache(cache).setUpstreamDataSourceFactory(upstream)
    fun playback(sidecar:File?=null):DataSource.Factory{
        val cached=CacheDataSource.Factory().setCache(cache)
            .setUpstreamDataSourceFactory(PlaceholderDataSource.FACTORY).setCacheWriteDataSinkFactory(null)
        val selected=sidecar?.canonicalFile?.let(android.net.Uri::fromFile) ?: return cached
        return DataSource.Factory{GrantedSidecarDataSource(cached,selected)}
    }
    override fun close(){try{cache.release()}finally{database.close()}}
}


/** The sole scheme exception is the exact caption file selected through native storage. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
private class GrantedSidecarDataSource(private val cached:DataSource.Factory,private val selected:android.net.Uri):DataSource{
    private val listeners=mutableListOf<androidx.media3.datasource.TransferListener>()
    private var current:DataSource?=null
    override fun addTransferListener(listener:androidx.media3.datasource.TransferListener){listeners.add(listener);current?.addTransferListener(listener)}
    override fun open(spec:androidx.media3.datasource.DataSpec):Long{
        check(current==null)
        val source=if(spec.uri==selected)androidx.media3.datasource.FileDataSource.Factory().createDataSource() else cached.createDataSource()
        current=source;listeners.forEach(source::addTransferListener)
        return source.open(spec)
    }
    override fun read(buffer:ByteArray,offset:Int,length:Int):Int=checkNotNull(current).read(buffer,offset,length)
    override fun getUri():android.net.Uri?=current?.uri
    override fun getResponseHeaders():Map<String,List<String>> = current?.responseHeaders ?: emptyMap()
    override fun close(){try{current?.close()}finally{current=null}}
}
