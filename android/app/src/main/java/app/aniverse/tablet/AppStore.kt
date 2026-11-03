package app.aniverse.tablet
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject
/** App-private storage. No exported provider, external path, web cookies or credentials. */
class AppStore(context: Context) : SQLiteOpenHelper(context, "aniverse-tablet.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) { db.execSQL("CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)") }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
    @Synchronized fun load(): JSONObject = readableDatabase.rawQuery("SELECT value FROM state WHERE id=1", null).use { if(it.moveToFirst()) JSONObject(it.getString(0)) else JSONObject() }
    @Synchronized fun save(value: JSONObject) {
        val text = value.toString(); require(text.toByteArray(Charsets.UTF_8).size <= 4*1024*1024) { "Local library exceeds its storage budget." }
        writableDatabase.execSQL("INSERT OR REPLACE INTO state(id,value) VALUES(1,?)", arrayOf(text))
    }
}
