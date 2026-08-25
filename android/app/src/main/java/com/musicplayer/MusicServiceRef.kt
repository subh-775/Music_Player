package com.musicplayer

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.util.Log

/**
 * A handle on react-native-track-player's running foreground service.
 *
 * Binding is how we reach the service object itself; [PlaybackSession] then
 * reads the audio session id off it so effects can attach to the right stream.
 *
 * Everything here is by name rather than by type. RNTP's classes are on the
 * compile classpath, but KotlinAudio's are pulled in with `implementation`
 * (not `api`), so referring to the player's type directly would not compile.
 * Going through Class.forName keeps this file buildable no matter how those
 * dependencies are wired.
 */
object MusicServiceRef {

    private const val TAG = "MusicServiceRef"
    private const val SERVICE = "com.doublesymmetry.trackplayer.service.MusicService"

    @Volatile
    var instance: Any? = null
        private set

    private var bound = false

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            // MusicBinder exposes the service through a `service` property;
            // read it by name so a rename degrades to "no EQ" rather than a
            // ClassCastException at runtime.
            instance = binder?.let {
                try {
                    val f = it.javaClass.getDeclaredField("service")
                    f.isAccessible = true
                    f.get(it)
                } catch (e: Exception) {
                    Log.w(TAG, "binder has no service field: ${e.message}")
                    null
                }
            }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            instance = null
        }
    }

    /**
     * Bind to the service if it is already running.
     *
     * Flags are 0 deliberately — NOT BIND_AUTO_CREATE. We must never be the
     * reason a playback foreground service starts; if nothing is playing there
     * is no session to attach to anyway, and starting one here would put a
     * notification on screen for no reason.
     */
    @Synchronized
    fun ensureBound(ctx: Context) {
        if (bound) return
        try {
            val intent = Intent(ctx, Class.forName(SERVICE))
            bound = ctx.applicationContext.bindService(intent, connection, 0)
            // A false return means the service was not running, and it STILL
            // leaves a client record behind that has to be released. This is
            // retried on every play, so without this the records accumulate.
            if (!bound) ctx.applicationContext.unbindService(connection)
        } catch (e: Exception) {
            Log.w(TAG, "could not bind playback service: ${e.message}")
        }
    }

    /**
     * Let the service go.
     *
     * A BOUND service cannot be destroyed by stopSelf(), and stopSelf() is
     * exactly what RNTP calls from onTaskRemoved under
     * StopPlaybackAndRemoveNotification. So this binding — taken with the
     * APPLICATION context, and therefore not released when the Activity died —
     * is what left the music playing and an orphan notification on screen after
     * the app was swiped away.
     *
     * It only ever happened with the equalizer or normalization actually ON:
     * since v1.0.9 both setters no-op before touching the session when they are
     * off, so nothing binds on a default install and the swipe-away worked.
     * That is why it looked like a new bug and why it survived testing.
     *
     * `instance` is cleared deliberately. The service object could be kept — it
     * is in our own process — but once the service is genuinely destroyed that
     * reference is a DIFFERENT object from the next MusicService, so effects
     * would attach to a dead session's id and silently do nothing. Null is
     * recoverable: ensureBound() runs again on the next play.
     */
    @Synchronized
    fun unbind(ctx: Context) {
        if (!bound) return
        try {
            ctx.applicationContext.unbindService(connection)
        } catch (e: Exception) {
            Log.w(TAG, "unbind failed: ${e.message}")
        }
        bound = false
        instance = null
    }
}
