package app.aniverse.tablet

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.media.AudioManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Rational
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView

/** Device-native decode with local file/subtitle URIs only; no desktop enhancement pipeline. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class OfflinePlayerActivity:Activity() {
    var player:ExoPlayer?=null
        private set
    private lateinit var playerView:PlayerView
    private lateinit var header:LinearLayout
    private lateinit var lock:Button
    private lateinit var message:TextView
    private lateinit var itemId:String
    private lateinit var offline:OfflineStore
    private var hls:OfflineHls?=null
    private var locked=false
    private var privatePlayback=false
    private val handler=Handler(Looper.getMainLooper())
    private val progress=object:Runnable{override fun run(){save();handler.postDelayed(this,2000)}}
    override fun onCreate(state:Bundle?){
        super.onCreate(state)
        offline=(application as TabletApplication).offline
        itemId=intent.getStringExtra("id") ?: return finish()
        privatePlayback=intent.getBooleanExtra("private",false)
        if(privatePlayback)window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val root=FrameLayout(this).apply{setBackgroundColor(Color.BLACK)}
        playerView=PlayerView(this).apply{setShowSubtitleButton(true);setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING);controllerShowTimeoutMs=4000}
        root.addView(playerView,FrameLayout.LayoutParams(-1,-1))
        header=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL;setPadding(dp(12),dp(6),dp(12),dp(6));setBackgroundColor(0xD5100C16.toInt())}
        header.addView(button("‹  Local watch"){finish()})
        header.addView(TextView(this).apply{setTextColor(Color.WHITE);textSize=17f;text=offline.videoTitle(itemId);maxLines=1;setPadding(dp(14),0,dp(14),0)},LinearLayout.LayoutParams(0,dp(48),1f))
        if(packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE))header.addView(button("Mini player"){locked=false;playerView.useController=true;enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(Rational(16,9)).build())})
        root.addView(header,FrameLayout.LayoutParams(-1,dp(60),Gravity.TOP))
        lock=button("Lock touches"){locked=!locked;playerView.useController=!locked;lock.text=if(locked)"Unlock touches" else "Lock touches";header.visibility=if(locked)View.GONE else View.VISIBLE;if(locked)playerView.hideController()}
        root.addView(lock,FrameLayout.LayoutParams(-2,dp(48),Gravity.TOP or Gravity.END).apply{topMargin=dp(70);rightMargin=dp(16)})
        message=TextView(this).apply{setTextColor(Color.WHITE);textSize=19f;gravity=Gravity.CENTER;setBackgroundColor(0xB0201728.toInt());setPadding(dp(20),dp(12),dp(20),dp(12));visibility=View.GONE}
        root.addView(message,FrameLayout.LayoutParams(-2,-2,Gravity.CENTER))
        root.keepSystemInsets();setContentView(root)
        try{
            val subtitles=offline.subtitle(itemId)?.let{file->listOf(MediaItem.SubtitleConfiguration.Builder(Uri.fromFile(file)).setMimeType(if(file.extension=="vtt")MimeTypes.TEXT_VTT else MimeTypes.APPLICATION_SUBRIP).setLabel(file.name.substringAfterLast('.').uppercase()+" subtitles").setLanguage("und").setSelectionFlags(C.SELECTION_FLAG_DEFAULT).build())} ?: emptyList()
            val manifest=offline.hlsMetadata(itemId)
            val media=MediaItem.Builder().setSubtitleConfigurations(subtitles).apply{
                if(manifest==null)setUri(Uri.fromFile(offline.video(itemId)))
                else{
                    hls=OfflineHls(this@OfflinePlayerActivity,offline.hlsDirectory(itemId))
                    setUri(manifest.getString("url"));setMimeType(MimeTypes.APPLICATION_M3U8)
                    val rows=manifest.optJSONArray("keys")
                    setStreamKeys((0 until (rows?.length() ?: 0)).map{index->
                        val key=rows!!.getJSONArray(index);androidx.media3.common.StreamKey(key.getInt(0),key.getInt(1))
                    })
                }
            }.build()
            val builder=ExoPlayer.Builder(this).setSeekBackIncrementMs(10000).setSeekForwardIncrementMs(10000)
            hls?.let{builder.setMediaSourceFactory(androidx.media3.exoplayer.source.DefaultMediaSourceFactory(this).setDataSourceFactory(it.playback(offline.subtitle(itemId))))}
            player=builder.build().apply{
                setAudioAttributes(AudioAttributes.DEFAULT,true);setHandleAudioBecomingNoisy(true);setMediaItem(media)
                addListener(object:Player.Listener{
                    override fun onPlayerError(error:androidx.media3.common.PlaybackException){show("This device could not play this file. Try another supported video or audio format.",false)}
                    override fun onPositionDiscontinuity(oldPosition:Player.PositionInfo,newPosition:Player.PositionInfo,reason:Int){
                        // Buffered seeks can clear an active sidecar cue without replaying its sample.
                        // Reprepare local media at the requested position; preserve pause and caption selection.
                        if(reason==Player.DISCONTINUITY_REASON_SEEK&&subtitles.isNotEmpty())player?.let{active->
                            val resume=active.playWhenReady
                            active.setMediaItem(media,newPosition.positionMs);active.prepare();active.playWhenReady=resume
                        }
                    }
                })
                prepare();if(!privatePlayback)seekTo(offline.position(itemId));playWhenReady=true
            }
            playerView.player=player;gestures();handler.postDelayed(progress,2000)
        }catch(_:Exception){show("Saved video is unavailable.",false)}
        onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT){if(locked){locked=false;lock.text="Lock touches";playerView.useController=true;header.visibility=View.VISIBLE}else finish()}
    }
    private fun dp(value:Int)=(value*resources.displayMetrics.density).toInt()
    private fun button(label:String,action:()->Unit)=Button(this).apply{text=label;textSize=13f;setTextColor(Color.rgb(255,183,117));setBackgroundColor(Color.TRANSPARENT);minHeight=dp(48);setPadding(dp(14),0,dp(14),0);setOnClickListener{action()}}
    private fun gestures(){
        val audio=getSystemService(Context.AUDIO_SERVICE) as AudioManager
        var downX=0f;var downY=0f;var brightness=.5f;var volume=0;var swiping=false
        val detector=GestureDetector(this,object:GestureDetector.SimpleOnGestureListener(){
            override fun onDown(event:MotionEvent)=true
            override fun onSingleTapConfirmed(event:MotionEvent):Boolean{if(!locked){if(playerView.isControllerFullyVisible)playerView.hideController() else playerView.showController()};return true}
            override fun onDoubleTap(event:MotionEvent):Boolean{if(!locked){val delta=if(event.x<playerView.width/2)-10000 else 10000;player?.let{it.seekTo((it.currentPosition+delta).coerceIn(0,it.duration.takeIf{duration->duration>0} ?: Long.MAX_VALUE))};show(if(delta<0)"−10 seconds" else "+10 seconds")};return true}
        })
        playerView.setOnTouchListener{_,event->
            if(locked)return@setOnTouchListener true
            when(event.actionMasked){
                MotionEvent.ACTION_DOWN->{downX=event.x;downY=event.y;brightness=window.attributes.screenBrightness.takeIf{it>=0} ?: .5f;volume=audio.getStreamVolume(AudioManager.STREAM_MUSIC);swiping=false}
                MotionEvent.ACTION_MOVE->{val delta=downY-event.y;if(kotlin.math.abs(delta)>dp(28)){swiping=true;val ratio=delta/playerView.height.coerceAtLeast(1);if(downX<playerView.width/2){val value=(brightness+ratio).coerceIn(.05f,1f);window.attributes=window.attributes.apply{screenBrightness=value};show("Brightness ${(value*100).toInt()}%")}
                    else{val max=audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);val value=(volume+ratio*max).toInt().coerceIn(0,max);audio.setStreamVolume(AudioManager.STREAM_MUSIC,value,0);show("Volume ${value*100/max.coerceAtLeast(1)}%")}}}
            }
            if(swiping)true else detector.onTouchEvent(event)
        }
    }
    private fun show(text:String,temporary:Boolean=true){message.text=text;message.visibility=View.VISIBLE;if(temporary)handler.postDelayed({message.visibility=View.GONE},1100)}
    private fun save(){if(!privatePlayback)player?.let{offline.savePosition(itemId,it.currentPosition,it.duration.coerceAtLeast(0))}}
    override fun onPictureInPictureModeChanged(inPictureInPictureMode:Boolean,newConfig:Configuration){super.onPictureInPictureModeChanged(inPictureInPictureMode,newConfig);header.visibility=if(inPictureInPictureMode)View.GONE else View.VISIBLE;lock.visibility=if(inPictureInPictureMode)View.GONE else View.VISIBLE;playerView.useController=!inPictureInPictureMode&&!locked}
    override fun onStop(){save();if(!isInPictureInPictureMode)player?.pause();super.onStop()}
    override fun onDestroy(){handler.removeCallbacksAndMessages(null);save();player?.release();player=null;hls?.close();hls=null;window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);super.onDestroy()}
}
