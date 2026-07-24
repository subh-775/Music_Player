package com.musicplayer

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.audiofx.Equalizer
import android.media.audiofx.LoudnessEnhancer
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray

/**
 * Audio effects and output routing.
 *
 * The WebView build shaped sound with eight Web Audio BiquadFilters. There is
 * no <audio> element here — ExoPlayer owns the stream — so the equivalent is
 * Android's own [Equalizer], and volume normalization becomes
 * [LoudnessEnhancer] rather than a DynamicsCompressor.
 *
 * ## Bands are the DEVICE's, not ours
 *
 * Android does not let an app choose band frequencies. Most phones expose five
 * bands at their own centre frequencies; some expose ten, and the valid gain
 * range differs too. So the 8-band curve the UI shows is INTERPOLATED onto
 * whatever this device actually has, at runtime, and clamped to its real range.
 * Nothing here is tuned for one handset.
 */
class AudioModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    override fun getName() = "Audio"

    private var equalizer: Equalizer? = null
    private var loudness: LoudnessEnhancer? = null
    private var attachedSession = -1

    /** Our 8 reference frequencies, in Hz. Must match src/eq.ts EQ_BANDS. */
    private val refFreqs = intArrayOf(60, 150, 400, 1000, 2400, 6000, 12000, 16000)

    /**
     * Attach (or re-attach) the effects to the audio session actually playing.
     *
     * Returns false when there is no session yet — nothing has played, so there
     * is nothing to attach to. The caller retries on the next playback start
     * rather than treating it as an error.
     */
    private fun ensureAttached(): Boolean {
        // Cheap and idempotent; the service may not have existed the first
        // time this ran, so it's retried rather than bound once at startup.
        MusicServiceRef.ensureBound(ctx)
        val session = PlaybackSession.currentId()
        if (session <= 0) return false
        if (equalizer != null && attachedSession == session) return true

        release()
        return try {
            // Priority 0: we are not a system effects app, and a higher number
            // would let us stomp on one the user actually installed.
            equalizer = Equalizer(0, session).apply { enabled = false }
            loudness = LoudnessEnhancer(session).apply { enabled = false }
            attachedSession = session
            Log.i(TAG, "effects attached to audio session $session")
            true
        } catch (e: Exception) {
            // Some devices refuse effects on a fast-path/offloaded session.
            Log.w(TAG, "could not attach audio effects: ${e.message}")
            release()
            false
        }
    }

    private fun release() {
        try { equalizer?.release() } catch (_: Exception) {}
        try { loudness?.release() } catch (_: Exception) {}
        equalizer = null
        loudness = null
        attachedSession = -1
    }

    /**
     * Linear interpolation of our 8-point curve at an arbitrary frequency.
     *
     * Interpolating in LOG frequency, not linear: 60Hz->150Hz and 12k->16k are
     * comparable musical distances but wildly different in Hz, and a linear
     * blend would make every device band land far too close to the top octave.
     */
    private fun gainAt(hz: Double, curve: DoubleArray): Double {
        if (hz <= refFreqs[0]) return curve[0]
        if (hz >= refFreqs[refFreqs.size - 1]) return curve[curve.size - 1]
        for (i in 0 until refFreqs.size - 1) {
            val lo = refFreqs[i].toDouble()
            val hi = refFreqs[i + 1].toDouble()
            if (hz in lo..hi) {
                val t = (Math.log(hz) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))
                return curve[i] + (curve[i + 1] - curve[i]) * t
            }
        }
        return 0.0
    }

    /** Report what this device can actually do, so the UI can say so honestly. */
    @ReactMethod
    fun getCapabilities(promise: Promise) {
        if (!ensureAttached()) {
            promise.resolve(com.facebook.react.bridge.Arguments.createMap().apply {
                putBoolean("available", false)
                putInt("bands", 0)
            })
            return
        }
        val eq = equalizer!!
        val range = eq.bandLevelRange // millibels, [min, max]
        promise.resolve(com.facebook.react.bridge.Arguments.createMap().apply {
            putBoolean("available", true)
            putInt("bands", eq.numberOfBands.toInt())
            putDouble("minDb", range[0] / 100.0)
            putDouble("maxDb", range[1] / 100.0)
        })
    }

    /**
     * Apply an 8-value dB curve. `enabled=false` turns the effect off outright
     * rather than flattening it, so a disabled EQ costs nothing in the chain.
     */
    @ReactMethod
    fun setEqualizer(enabled: Boolean, gainsDb: ReadableArray, promise: Promise) {
        if (!ensureAttached()) {
            promise.resolve(false)
            return
        }
        val eq = equalizer!!
        try {
            if (!enabled) {
                eq.enabled = false
                promise.resolve(true)
                return
            }

            val curve = DoubleArray(refFreqs.size) { i ->
                if (i < gainsDb.size()) gainsDb.getDouble(i) else 0.0
            }
            val range = eq.bandLevelRange
            val minMb = range[0].toInt()
            val maxMb = range[1].toInt()

            for (b in 0 until eq.numberOfBands.toInt()) {
                val band = b.toShort()
                // getCenterFreq is in milliHertz.
                val hz = eq.getCenterFreq(band) / 1000.0
                val mb = Math.round(gainAt(hz, curve) * 100.0).toInt()
                eq.setBandLevel(band, mb.coerceIn(minMb, maxMb).toShort())
            }
            eq.enabled = true
            promise.resolve(true)
        } catch (e: Exception) {
            Log.w(TAG, "setEqualizer failed: ${e.message}")
            promise.resolve(false)
        }
    }

    /**
     * Volume normalization. The WebView used a compressor with makeup gain;
     * LoudnessEnhancer is the native equivalent and is measured in millibels of
     * target gain.
     */
    @ReactMethod
    fun setNormalize(enabled: Boolean, promise: Promise) {
        if (!ensureAttached()) {
            promise.resolve(false)
            return
        }
        try {
            loudness?.apply {
                setTargetGain(if (enabled) 600 else 0) // +6dB, matching the web build
                this.enabled = enabled
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    /**
     * The name of the current output device, or null when it's the phone's own
     * speaker/earpiece — the UI shows this line only when sound is going
     * somewhere else, so "speaker" is deliberately reported as nothing.
     */
    @ReactMethod
    fun getAudioOutput(promise: Promise) {
        try {
            val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val outs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)

            // Rank matters — same lesson the WebView build learned on-device.
            // SCO is the PHONE's own call endpoint and reports the handset's
            // model as its productName, which is how "my phone's name" showed
            // up as the headphones. Real headsets (A2DP / BLE / wired) win.
            fun rank(t: Int) = when (t) {
                AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> 0
                AudioDeviceInfo.TYPE_USB_HEADSET -> 2
                AudioDeviceInfo.TYPE_WIRED_HEADSET,
                AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> 3
                AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> 4
                else -> if (android.os.Build.VERSION.SDK_INT >= 31 &&
                    t == AudioDeviceInfo.TYPE_BLE_HEADSET) 1 else 99
            }

            val routed = outs.filter { rank(it.type) < 99 }.minByOrNull { rank(it.type) }
            if (routed == null) {
                promise.resolve(null) // phone speaker — the UI shows nothing
                return
            }
            val name = routed.productName?.toString()?.trim().orEmpty()
            // Some OEMs report the handset's own model as productName. That is
            // never the headphone's name, so say "Bluetooth" instead of a lie.
            val phoneOwn = name.isEmpty() ||
                name.equals(android.os.Build.MODEL, true) ||
                name.equals(android.os.Build.PRODUCT, true)
            promise.resolve(
                when {
                    !phoneOwn -> name
                    routed.type == AudioDeviceInfo.TYPE_USB_HEADSET -> "USB headphones"
                    routed.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
                        routed.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "Wired headphones"
                    else -> "Bluetooth"
                },
            )
        } catch (e: Exception) {
            promise.resolve(null)
        }
    }

    /**
     * Dominant colour of an artwork image, as "#rrggbb", or null when it can't
     * be worked out. Palette is the platform's own tool for exactly this.
     *
     * The bitmap is decoded small (Palette samples anyway, detail is wasted)
     * and the whole thing is best-effort: a null just means the UI keeps its
     * plain background.
     */
    @ReactMethod
    fun artworkColor(url: String, promise: Promise) {
        Thread {
            try {
                val conn = java.net.URL(url).openConnection()
                conn.connectTimeout = 5000
                conn.readTimeout = 8000
                val bytes = conn.getInputStream().use { it.readBytes() }

                // Two-pass decode: bounds first, then sampled down to ~112px.
                val bounds = android.graphics.BitmapFactory.Options().apply {
                    inJustDecodeBounds = true
                }
                android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                var sample = 1
                while (bounds.outWidth / (sample * 2) >= 112) sample *= 2
                val opts = android.graphics.BitmapFactory.Options().apply {
                    inSampleSize = sample
                }
                val bmp = android.graphics.BitmapFactory
                    .decodeByteArray(bytes, 0, bytes.size, opts)
                if (bmp == null) {
                    promise.resolve(null)
                    return@Thread
                }
                val palette = androidx.palette.graphics.Palette.from(bmp).generate()
                bmp.recycle()
                // Vibrant reads best against a dark UI; muted and dominant are
                // the fallbacks, in that order.
                val color = palette.getVibrantColor(
                    palette.getMutedColor(palette.getDominantColor(0)),
                )
                promise.resolve(
                    if (color == 0) null else String.format("#%06x", color and 0xffffff),
                )
            } catch (e: Exception) {
                promise.resolve(null)
            }
        }.start()
    }

    // ─── Real crossfade: a SECOND player for the overlap ────────────────────
    //
    // react-native-track-player runs one ExoPlayer → one output, so from JS we
    // can only fade that single stream up or down. True crossfade needs two
    // songs audible at once. This is that second stream: a plain MediaPlayer
    // (no new dependency, and it does NOT grab audio focus, so it won't fight
    // RNTP) that plays the INCOMING track rising while JS fades the outgoing
    // RNTP track down. Android's own mixer sums the two — that's the overlap.
    //
    // The handoff is driven from JS on the real track change: it reads
    // crossfadePosition(), seeks RNTP there under cover of this player's audio,
    // then stopCrossfade() cuts this one. Kept entirely on the main looper so
    // MediaPlayer's state machine and its callbacks never race.
    private var cfPlayer: MediaPlayer? = null
    private var cfRamp: Runnable? = null
    private val cfHandler = Handler(Looper.getMainLooper())

    @ReactMethod
    fun startCrossfade(url: String, durationMs: Int, promise: Promise) {
        cfHandler.post {
            try {
                stopCfInternal()
                val mp = MediaPlayer().apply {
                    setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                            .build(),
                    )
                    setDataSource(url)
                    setVolume(0f, 0f)
                    setOnPreparedListener { p ->
                        try {
                            p.start()
                            rampUp(p, durationMs)
                        } catch (_: Exception) {}
                    }
                    // A dead stream must not crash — just abandon the overlap;
                    // the outgoing track still ends and RNTP advances normally.
                    setOnErrorListener { _, _, _ ->
                        stopCfInternal()
                        true
                    }
                    prepareAsync()
                }
                cfPlayer = mp
                promise.resolve(true)
            } catch (e: Exception) {
                Log.w(TAG, "startCrossfade failed: ${e.message}")
                stopCfInternal()
                promise.resolve(false)
            }
        }
    }

    private fun rampUp(mp: MediaPlayer, durationMs: Int) {
        val steps = 16
        val stepMs = (durationMs / steps).coerceAtLeast(30).toLong()
        var i = 0
        val r = object : Runnable {
            override fun run() {
                if (cfPlayer !== mp) return // superseded — stop ramping
                i++
                val v = (i.toFloat() / steps).coerceIn(0f, 1f)
                try {
                    mp.setVolume(v, v)
                } catch (_: Exception) {
                    return
                }
                if (i < steps) cfHandler.postDelayed(this, stepMs)
            }
        }
        cfRamp = r
        cfHandler.postDelayed(r, stepMs)
    }

    /** Where the overlap player has reached, in seconds — so JS can seek RNTP to
     *  the same spot for a near-seamless handoff. -1 when nothing is crossfading. */
    @ReactMethod
    fun crossfadePosition(promise: Promise) {
        cfHandler.post {
            val mp = cfPlayer
            promise.resolve(
                try {
                    if (mp != null) mp.currentPosition / 1000.0 else -1.0
                } catch (_: Exception) {
                    -1.0
                },
            )
        }
    }

    @ReactMethod
    fun stopCrossfade(promise: Promise) {
        cfHandler.post {
            stopCfInternal()
            promise.resolve(true)
        }
    }

    private fun stopCfInternal() {
        cfRamp?.let { cfHandler.removeCallbacks(it) }
        cfRamp = null
        try { cfPlayer?.stop() } catch (_: Exception) {}
        try { cfPlayer?.release() } catch (_: Exception) {}
        cfPlayer = null
    }

    override fun onCatalystInstanceDestroy() {
        release()
        stopCfInternal()
    }

    companion object {
        private const val TAG = "AudioModule"
    }
}
