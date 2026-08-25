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
import com.facebook.react.bridge.LifecycleEventListener
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
    ReactContextBaseJavaModule(ctx), LifecycleEventListener {

    init {
        ctx.addLifecycleEventListener(this)
    }

    override fun getName() = "Audio"

    private var equalizer: Equalizer? = null
    private var loudness: LoudnessEnhancer? = null
    private var attachedSession = -1

    /**
     * Why the effects are not working, in the user's own words.
     *
     * Every failure path here used to `promise.resolve(false)` and say nothing,
     * so an equalizer that silently did nothing was indistinguishable from one
     * that was working — with no way to tell which without a USB cable. This is
     * surfaced through getDiagnostics() on the Settings > Diagnostics screen.
     */
    @Volatile private var lastError: String = ""

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
        if (MusicServiceRef.instance == null) {
            lastError = "Playback service not bound yet — play something first."
            return false
        }
        val session = PlaybackSession.currentId()
        if (session <= 0) {
            // -1 means the reflection into RNTP/KotlinAudio came back empty.
            // In a release build that almost always means a keep rule stopped
            // matching after a dependency upgrade, so say so plainly.
            lastError =
                "No audio session (id=$session). Nothing has played yet, or the " +
                    "player's internals could not be reached."
            return false
        }
        if (equalizer != null && attachedSession == session) return true

        release()
        return try {
            // Priority 0: we are not a system effects app, and a higher number
            // would let us stomp on one the user actually installed.
            equalizer = Equalizer(0, session).apply { enabled = false }
            loudness = LoudnessEnhancer(session).apply { enabled = false }
            attachedSession = session
            lastError = ""
            Log.i(TAG, "effects attached to audio session $session")
            true
        } catch (e: Exception) {
            // Some devices refuse effects on a fast-path/offloaded session.
            lastError = "Device refused audio effects: ${e.message}"
            Log.w(TAG, "could not attach audio effects: ${e.message}")
            release()
            false
        }
    }

    /**
     * Everything needed to explain a non-working equalizer, without a cable.
     * Rendered by the in-app Diagnostics screen.
     */
    @ReactMethod
    fun getDiagnostics(promise: Promise) {
        val map = com.facebook.react.bridge.Arguments.createMap()
        try {
            val bound = MusicServiceRef.instance != null
            val session = PlaybackSession.currentId()
            map.putBoolean("serviceBound", bound)
            map.putInt("audioSession", session)
            map.putBoolean("effectsAttached", equalizer != null)
            map.putInt("attachedSession", attachedSession)
            map.putBoolean("eqEnabled", equalizer?.enabled == true)
            map.putInt("bands", equalizer?.numberOfBands?.toInt() ?: 0)
            map.putBoolean("loudnessEnabled", loudness?.enabled == true)
            // Proves whether the volume reflection still resolves — the same
            // path the crossfade fade depends on.
            map.putBoolean("playerReachable", PlaybackSession.exoPlayer() != null)
            map.putString("lastError", lastError)
        } catch (e: Exception) {
            map.putString("lastError", "diagnostics failed: ${e.message}")
        }
        promise.resolve(map)
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

    /**
     * Report what this device can actually do, so the UI can say so honestly.
     *
     * This is the ONE place that still attaches the chain unconditionally — it
     * has to, because the real band count and gain range can only be read off a
     * live Equalizer. That means opening this screen mid-song can cost the same
     * momentary level step the setters now avoid; on the Equalizer screen
     * specifically, that is a fair trade for telling the truth about the device.
     *
     * `reason` is what makes a refusal legible: without it, a device that flatly
     * refuses effects and a device with nothing playing yet produced the exact
     * same empty answer, and the screen guessed.
     */
    @ReactMethod
    fun getCapabilities(promise: Promise) {
        if (!ensureAttached()) {
            promise.resolve(com.facebook.react.bridge.Arguments.createMap().apply {
                putBoolean("available", false)
                putInt("bands", 0)
                putString("reason", lastError)
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
        // Bind FIRST, always — before the short-circuit below.
        // ensureAttached() was the only thing in this file that ever called
        // ensureBound(), and MusicServiceRef.instance is what PlaybackSession
        // reaches the ExoPlayer through. Short-circuiting straight past it would
        // have left instance null on a default install, and taken every volume
        // ramp (the crossfade fade-out and the new fade-in) down with it —
        // setExoVolume() would silently return false forever. Idempotent and a
        // no-op once bound.
        MusicServiceRef.ensureBound(ctx)
        // Nothing to attach FOR. Creating an Equalizer only to set enabled=false
        // inserts an effect into a LIVE audio session, and inserting one makes
        // the audio HAL re-route the mix — audible as a brief level step whether
        // or not the effect does anything. Both eqEnabled and normalizeVolume
        // default to false, so on a default install that insertion was the ONLY
        // thing happening, and it is the "volume jumps for a moment on the first
        // play" artefact. An already-attached chain still gets the call, so
        // turning the EQ off mid-song works exactly as before.
        if (!enabled && equalizer == null) {
            promise.resolve(true)
            return
        }
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
            // Logged on SUCCESS too, not just failure. "The EQ does nothing" has
            // two completely different causes — it never applied, or it applied
            // and the device's own post-processing swallowed it — and only the
            // success line can tell them apart over a cable.
            Log.i(
                TAG,
                "equalizer applied: session=$attachedSession bands=${eq.numberOfBands} " +
                    "range=${minMb}..${maxMb}mB curve=${curve.joinToString(",")}",
            )
            promise.resolve(true)
        } catch (e: Exception) {
            Log.w(TAG, "setEqualizer failed: ${e.message}")
            promise.resolve(false)
        }
    }

    /**
     * A logcat sink for the JS side.
     *
     * In a release build React Native installs no console, so everything the app
     * knows about itself died inside diag.ts's in-memory ring buffer — which is
     * why a full logcat capture during a real session contained not one line
     * from our own code. This is the missing half: `adb logcat -s MPJS` now
     * shows what the app tried and what came back.
     */
    @ReactMethod
    fun log(tag: String, msg: String) {
        Log.i("MPJS", "[$tag] $msg")
    }

    /**
     * Volume normalization. The WebView used a compressor with makeup gain;
     * LoudnessEnhancer is the native equivalent and is measured in millibels of
     * target gain.
     */
    @ReactMethod
    fun setNormalize(enabled: Boolean, promise: Promise) {
        // Bind FIRST, always — before the short-circuit below.
        // ensureAttached() was the only thing in this file that ever called
        // ensureBound(), and MusicServiceRef.instance is what PlaybackSession
        // reaches the ExoPlayer through. Short-circuiting straight past it would
        // have left instance null on a default install, and taken every volume
        // ramp (the crossfade fade-out and the new fade-in) down with it —
        // setExoVolume() would silently return false forever. Idempotent and a
        // no-op once bound.
        MusicServiceRef.ensureBound(ctx)
        // Same reasoning as setEqualizer: off + never attached = do nothing.
        if (!enabled && loudness == null) {
            promise.resolve(true)
            return
        }
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
    /**
     * When each output device turned up, keyed by device id.
     *
     * Registered lazily on the first query. Android tells us about connects and
     * disconnects; it does NOT tell us which device media is routed to, so
     * "most recently connected" is the closest honest proxy — and it is what
     * makes switching headsets mid-song name the new one.
     */
    private val seenAt = HashMap<Int, Long>()
    private var deviceCallback: android.media.AudioDeviceCallback? = null

    private fun ensureDeviceWatch(am: AudioManager) {
        if (deviceCallback != null) return
        val cb = object : android.media.AudioDeviceCallback() {
            override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>?) {
                val now = System.currentTimeMillis()
                added?.forEach { seenAt[it.id] = now }
            }

            override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>?) {
                removed?.forEach { seenAt.remove(it.id) }
            }
        }
        deviceCallback = cb
        am.registerAudioDeviceCallback(cb, Handler(Looper.getMainLooper()))
    }

    @ReactMethod
    fun getAudioOutput(promise: Promise) {
        try {
            val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            ensureDeviceWatch(am)
            val outs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            // Seed anything that was already connected before we started
            // watching, so the ordering below has a timestamp for every device.
            outs.forEach { if (!seenAt.containsKey(it.id)) seenAt[it.id] = 0L }

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

            // Among equally-ranked candidates, prefer the one that connected
            // MOST RECENTLY. getDevices() lists everything currently connected,
            // not what audio is actually routed to — so with two paired
            // headsets it kept naming the first one in the list, which is why
            // switching devices mid-song left the old name on screen.
            val routed = outs
                .filter { rank(it.type) < 99 }
                .sortedWith(
                    compareBy<AudioDeviceInfo> { rank(it.type) }
                        .thenByDescending { seenAt[it.id] ?: 0L },
                )
                .firstOrNull()
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

    // ─── Main player volume, ramped NATIVELY ────────────────────────────────
    //
    // This exists because the JS version of it was the "volume drops on track
    // change and never recovers" bug. JS ran the ramp as a loop of
    // setTimeout+setVolume; Android throttles (and eventually freezes) RN's JS
    // timers once the app is backgrounded or the screen locks, so the loop
    // stalled PART WAY DOWN and the volume simply stayed there. Reopening the
    // app thawed the thread and the ramp continued — which is precisely the
    // "it gradually ramps back up by itself when I reopen" symptom.
    //
    // A Handler on the main looper is not throttled that way: the process is
    // alive because RNTP holds a mediaPlayback foreground service, so this runs
    // to completion with the screen off.
    //
    // Every ramp is also SELF-RESTORING: once it reaches the floor it schedules
    // a hard reset back to 1.0. Nothing — a frozen JS thread, a killed bridge, a
    // crossfade whose handoff never arrives — can leave the player stuck quiet.
    private var volRamp: Runnable? = null
    private var volRestore: Runnable? = null
    private val volHandler = Handler(Looper.getMainLooper())

    /**
     * Set ExoPlayer's volume by reflection. Main looper only (see exoPlayer()).
     *
     * isAccessible is not optional here: ExoPlayer's concrete class
     * (ExoPlayerImpl) is package-private, and invoking even a PUBLIC method on
     * an instance of a non-public class throws IllegalAccessException without
     * it — the method would resolve fine and then fail at the call.
     */
    private fun setExoVolume(v: Float): Boolean {
        val exo = PlaybackSession.exoPlayer() ?: return false
        return try {
            val m = exo.javaClass.getMethod("setVolume", Float::class.javaPrimitiveType)
            m.isAccessible = true
            m.invoke(exo, v.coerceIn(0f, 1f))
            true
        } catch (e: Exception) {
            Log.w(TAG, "setVolume failed: ${e.message}")
            false
        }
    }

    private fun cancelVolWork() {
        volRamp?.let { volHandler.removeCallbacks(it) }
        volRestore?.let { volHandler.removeCallbacks(it) }
        volRamp = null
        volRestore = null
    }

    /**
     * Fade the playing track down over [durationMs], then restore full volume
     * shortly after — by which point the queue has advanced to the next track,
     * so the incoming song is never the one left quiet.
     */
    @ReactMethod
    fun fadeOutPlayer(durationMs: Int, promise: Promise) {
        volHandler.post {
            cancelVolWork()
            val steps = 16
            val stepMs = (durationMs / steps).coerceAtLeast(30).toLong()
            var i = 0
            val ramp = object : Runnable {
                override fun run() {
                    i++
                    val v = (1f - i.toFloat() / steps).coerceAtLeast(FADE_FLOOR)
                    setExoVolume(v)
                    if (i < steps) {
                        volHandler.postDelayed(this, stepMs)
                    } else {
                        volRamp = null
                    }
                }
            }
            volRamp = ramp
            volHandler.postDelayed(ramp, stepMs)

            // Fail-safe ONLY. It must not race the crossfade handoff: while the
            // overlap player is still sounding, snapping RNTP back to full
            // volume plays the incoming track twice at once, slightly offset —
            // the "I hear two sounds for a second" clash. So this waits well
            // past any overlap, and the handoff (which cancels it via
            // restorePlayerVolume) is what normally restores volume.
            val restore = Runnable {
                volRamp?.let { volHandler.removeCallbacks(it) }
                volRamp = null
                volRestore = null
                if (cfPlayer != null) {
                    // An overlap is STILL playing — restoring now would double
                    // the audio. Cut the overlap first, then come back to full.
                    stopCfInternal()
                }
                setExoVolume(1f)
            }
            volRestore = restore
            volHandler.postDelayed(restore, durationMs.toLong() + RESTORE_GRACE_MS)
            promise.resolve(true)
        }
    }

    /**
     * Ramp the volume UP over [durationMs] at the start of a track.
     *
     * The mirror of fadeOutPlayer, and the reason it exists is the same reason
     * every other music player does this: the first moments of a stream are when
     * the output path is still settling — ExoPlayer has just opened the audio
     * track, the effects chain attaches a beat later, and a Bluetooth codec is
     * still negotiating. Coming in from near-silence hides all of it.
     *
     * It is NATIVE for the reason the comment on fadeOutPlayer gives: a JS ramp
     * stalls the moment Android throttles RN's timers and leaves the track stuck
     * quiet. This runs on the main looper, which the mediaPlayback foreground
     * service keeps alive, and — like every ramp here — it FORCES full volume
     * afterwards, so an interrupted rise can never leave audio quiet.
     */
    @ReactMethod
    fun fadeInPlayer(durationMs: Int, promise: Promise) {
        volHandler.post {
            cancelVolWork()
            val steps = 12
            val stepMs = (durationMs / steps).coerceAtLeast(8).toLong()
            setExoVolume(FADE_FLOOR)
            var i = 0
            val ramp = object : Runnable {
                override fun run() {
                    i++
                    // Ease-OUT: most of the rise happens in the first third, so
                    // this reads as "instant but soft" rather than as a fade.
                    val t = i.toFloat() / steps
                    val eased = 1f - (1f - t) * (1f - t)
                    setExoVolume(FADE_FLOOR + (1f - FADE_FLOOR) * eased)
                    if (i < steps) {
                        volHandler.postDelayed(this, stepMs)
                    } else {
                        volRamp = null
                    }
                }
            }
            volRamp = ramp
            volHandler.postDelayed(ramp, stepMs)

            // Fail-safe, exactly as the fade-out has one. No crossfade check
            // here: a fade-IN only ever runs at the start of a fresh play, and
            // playTrack cancels any crossfade before it calls this.
            val restore = Runnable {
                volRamp?.let { volHandler.removeCallbacks(it) }
                volRamp = null
                volRestore = null
                setExoVolume(1f)
            }
            volRestore = restore
            volHandler.postDelayed(restore, durationMs.toLong() + RESTORE_GRACE_MS)
            promise.resolve(true)
        }
    }

    /** Cancel any ramp and put the player back to full volume, immediately. */
    @ReactMethod
    fun restorePlayerVolume(promise: Promise) {
        volHandler.post {
            cancelVolWork()
            promise.resolve(setExoVolume(1f))
        }
    }

    override fun onHostPause() {}

    /**
     * The UI is going away — release the playback service.
     *
     * This is the half of the swipe-away that was missing: RNTP stops playback
     * and calls stopSelf() from onTaskRemoved, and Android keeps the service
     * alive anyway while anything is bound to it. Nothing here ever unbound, so
     * with the equalizer on the music simply carried on with its notification.
     *
     * Deliberately NOT release() as well. Pressing back to exit destroys the
     * Activity too, and playback legitimately continues then — tearing the
     * effects down there would silently drop the user's EQ mid-song, and
     * removing an AudioEffect from a live session makes the audio HAL re-route
     * the mix, which is audible as a step in level. Unbinding is what fixes the
     * reported bug; releasing is what would cause the next one.
     */
    override fun onHostDestroy() {
        MusicServiceRef.unbind(ctx)
    }

    /**
     * Re-take the binding on the way back in.
     *
     * ensureAttached() would do it lazily, but only on the next play — and the
     * crossfade ramp reaches ExoPlayer through this same binding, so without
     * this the fade at the end of an already-playing song would be a no-op for
     * everyone who had exited with back and come back. Cheap and idempotent:
     * it returns immediately when already bound, and binds nothing at all when
     * the service is not running.
     */
    override fun onHostResume() {
        MusicServiceRef.ensureBound(ctx)
    }

    override fun onCatalystInstanceDestroy() {
        release()
        stopCfInternal()
        deviceCallback?.let {
            try {
                (ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager)
                    .unregisterAudioDeviceCallback(it)
            } catch (_: Exception) {}
        }
        deviceCallback = null
        // The bridge is going away — make sure we are not leaving the player
        // faded down with nothing left alive to restore it.
        volHandler.post {
            cancelVolWork()
            setExoVolume(1f)
        }
    }

    companion object {
        private const val TAG = "AudioModule"
        /** Never ramp fully to 0 — ExoPlayer at exactly 0 on some devices drops
         *  the output path, which clicks audibly when it comes back. */
        private const val FADE_FLOOR = 0.04f
        /** How long after a fade ends before volume is forced back to full. */
        private const val RESTORE_GRACE_MS = 1500L
    }
}
