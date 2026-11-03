package app.aniverse.tablet.fixture
import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File

/** Debug/instrumentation only. Never part of release source sets or exported to other apps. */
class FixtureProvider:ContentProvider(){
 private fun file(uri:Uri):File{val name=uri.lastPathSegment ?: error("Missing fixture");require(name in setOf("clip.mp4","sub.srt","sub.vtt","large.srt","stall.mp4","prefix.mp4","late.mp4","slice.mp4"));return File(context!!.cacheDir,"offline-fixtures/$name")}
 override fun onCreate()=true
 override fun getType(uri:Uri)=if(uri.lastPathSegment?.endsWith(".mp4")==true)"video/mp4" else "text/plain"
 override fun query(uri:Uri,projection:Array<out String>?,selection:String?,selectionArgs:Array<out String>?,sortOrder:String?):Cursor=MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE)).apply{if(uri.lastPathSegment=="late.mp4")late.await(10,java.util.concurrent.TimeUnit.SECONDS);val value=file(uri);addRow(arrayOf<Any>(value.name,value.length()))}
 override fun openFile(uri:Uri,mode:String):ParcelFileDescriptor{require(mode=="r");if(uri.lastPathSegment in setOf("stall.mp4","prefix.mp4")){
  val pair=ParcelFileDescriptor.createPipe();held.add(pair[1]);if(uri.lastPathSegment=="prefix.mp4")ParcelFileDescriptor.AutoCloseOutputStream(ParcelFileDescriptor.dup(pair[1].fileDescriptor)).use{it.write(ByteArray(64){1})};return pair[0]
 };return ParcelFileDescriptor.open(file(if(uri.lastPathSegment=="late.mp4")uri.buildUpon().path("clip.mp4").build() else uri),ParcelFileDescriptor.MODE_READ_ONLY)}
 override fun openAssetFile(uri:Uri,mode:String):android.content.res.AssetFileDescriptor {
  if(uri.lastPathSegment=="slice.mp4"){val original=file(uri.buildUpon().path("clip.mp4").build());val sliced=file(uri);sliced.outputStream().use{output->output.write(ByteArray(16){42});original.inputStream().use{it.copyTo(output)}};return android.content.res.AssetFileDescriptor(ParcelFileDescriptor.open(sliced,ParcelFileDescriptor.MODE_READ_ONLY),16,original.length())}
  return android.content.res.AssetFileDescriptor(openFile(uri,mode),0,android.content.res.AssetFileDescriptor.UNKNOWN_LENGTH)
 }
 companion object {val held=java.util.concurrent.CopyOnWriteArrayList<ParcelFileDescriptor>();@Volatile var late=java.util.concurrent.CountDownLatch(1);fun release(){late.countDown();for(item in held)runCatching{item.close()};held.clear()}}
 override fun insert(uri:Uri,values:ContentValues?):Uri?=throw UnsupportedOperationException()
 override fun delete(uri:Uri,selection:String?,selectionArgs:Array<out String>?):Int=throw UnsupportedOperationException()
 override fun update(uri:Uri,values:ContentValues?,selection:String?,selectionArgs:Array<out String>?):Int=throw UnsupportedOperationException()
}
