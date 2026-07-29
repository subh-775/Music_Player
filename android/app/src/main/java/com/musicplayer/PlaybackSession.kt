package com.musicplayer

import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Finds the ExoPlayer audio session id that react-native-track-player is
 * playing on, so audio effects can be attached to it.
 *
 * ## Why this is reflection, and why that is the honest choice
 *
 * Attaching an [android.media.audiofx.Equalizer] requires the session id of
 * the stream you want to shape. RNTP does not expose one:
 *
 *   - `MusicService.player` is `private`
 *   - KotlinAudio's `BaseAudioPlayer.exoPlayer` is `protected`
 *
 * so there is no supported path to it from outside. The alternatives were
 * worse, not merely different:
 *
 *   - Attaching to the global output mix (session 0) is deprecated as of
 *     API 28 and is silently ignored by a good number of OEM builds — the EQ
 *     would appear to work and do nothing, which is the worst outcome.
 *   - Patching RNTP's source with patch-package can't reach `exoPlayer`
 *     either, because `protected` is not visible to the service that merely
 *     HOLDS the player.
 *
 * So: reflection, kept to one small place, failing softly. If a future RNTP
 * renames these fields the EQ turns itself off and reports unavailable — the
 * app keeps playing. See proguard-rules.pro for the keep rules that stop R8
 * renaming these out from under us in a release build.
 *
 * ponytail: reflection into two libraries' internals. Ceiling = breaks on an
 * RNTP/KotlinAudio major upgrade; upgrade path = a real API if RNTP ever
 * exposes the session, at which point this whole file is deleted.
 */
object PlaybackSession {

    @Volatile private var cached = -1

    /**
     * The live audio session id, or -1 when nothing is playing yet or the
     * fields could not be found.
     *
     * ExoPlayer enforces thread confinement: getAudioSessionId() called from
     * any thread but the player's application thread (main) throws. React
     * native-module methods run on their own thread, so this hops to the main
     * looper and waits briefly — without the hop every lookup "failed" with a
     * wrong-thread IllegalStateException and the EQ silently attached to
     * nothing.
     */
    fun currentId(): Int {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return lookup()
        }
        var result = -1
        val latch = CountDownLatch(1)
        Handler(Looper.getMainLooper()).post {
            result = lookup()
            latch.countDown()
        }
        return if (latch.await(2, TimeUnit.SECONDS)) result else -1
    }

    private fun lookup(): Int {
        val exo = exoPlayer() ?: return -1
        return try {
            val m = exo.javaClass.getMethod("getAudioSessionId")
            m.isAccessible = true // ExoPlayerImpl is package-private (see AudioModule)
            val id = m.invoke(exo) as? Int ?: return -1
            cached = id
            id
        } catch (e: Exception) {
            Log.w(TAG, "audio session lookup failed: ${e.message}")
            -1
        }
    }

    /**
     * The live ExoPlayer instance, or null when nothing is playing yet.
     *
     * MUST be called on the main looper — ExoPlayer enforces thread confinement
     * on every accessor, so a caller that touches the returned object off-thread
     * gets an IllegalStateException. [AudioModule]'s volume ramp posts to the
     * main handler for exactly this reason.
     */
    fun exoPlayer(): Any? {
        val service = MusicServiceRef.instance ?: return null
        return try {
            val playerField = service.javaClass.getDeclaredField("player")
            playerField.isAccessible = true
            val player = playerField.get(service) ?: return null

            // exoPlayer lives on the superclass (BaseAudioPlayer), so walk up
            // rather than assuming which class in the chain declares it.
            var klass: Class<*>? = player.javaClass
            while (klass != null) {
                try {
                    val f = klass.getDeclaredField("exoPlayer")
                    f.isAccessible = true
                    return f.get(player)
                } catch (_: NoSuchFieldException) {
                    klass = klass.superclass
                }
            }
            Log.w(TAG, "exoPlayer field not found on ${player.javaClass.name}")
            null
        } catch (e: Exception) {
            Log.w(TAG, "exoPlayer lookup failed: ${e.message}")
            null
        }
    }

    private const val TAG = "PlaybackSession"
}
