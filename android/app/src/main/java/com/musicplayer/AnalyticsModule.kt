package com.musicplayer

import android.annotation.SuppressLint
import android.content.Context
import android.os.Bundle
import android.provider.Settings
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.google.firebase.analytics.FirebaseAnalytics
import com.google.firebase.crashlytics.FirebaseCrashlytics
import java.security.MessageDigest

/**
 * Usage statistics and crash reports, through Firebase (Google Analytics for
 * apps, and Crashlytics).
 *
 * Crashlytics records native crashes and freezes (ANRs) on its own; JS errors
 * that the app survives arrive through `recordError` below, as non-fatal
 * issues with the JS stack. Fatal JS errors are not sent from here: React
 * Native turns them into a native crash, which Crashlytics already records.
 *
 * Firebase itself collects the basics with no code here: installs, active
 * users, sessions, app version, country and city (derived by Google from the
 * connection; the IP is never shown to us). This module adds the app's own
 * events (see src/analytics.ts) and one stable user id.
 *
 * The id is a hash of Android's per-app device id, so one phone stays one
 * user through reinstalls and "clear data", where Firebase's own id would
 * start over and count the same person twice. The raw device id never leaves
 * the phone. It is set in MainApplication.onCreate (`identify`), before any
 * screen opens: set here, when React loads, it arrived after Firebase's own
 * first events, and one phone showed up as two users.
 *
 * Off unless the build has a Firebase config: google-services.json is not in
 * the repo (CI writes it from a secret), so a contributor's or a fork's build
 * has no `google_app_id` and every call here is a no-op.
 */
class AnalyticsModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "Analytics"

    private val fa: FirebaseAnalytics? =
        runCatching { if (configured(ctx)) FirebaseAnalytics.getInstance(ctx) else null }
            .getOrNull()

    companion object {
        private fun configured(c: Context) =
            c.resources.getIdentifier("google_app_id", "string", c.packageName) != 0

        /** Attach the stable id. Called once, from MainApplication.onCreate. */
        fun identify(c: Context) {
            if (!configured(c)) return
            val id = stableId(c)
            runCatching { FirebaseAnalytics.getInstance(c).setUserId(id) }
            // The same id on crash reports, so a crash links to its user.
            runCatching { FirebaseCrashlytics.getInstance().setUserId(id) }
        }

        @SuppressLint("HardwareIds")
        private fun stableId(c: Context): String {
            val raw = Settings.Secure.getString(c.contentResolver, Settings.Secure.ANDROID_ID)
                ?: return ""
            return MessageDigest.getInstance("SHA-256")
                .digest(raw.toByteArray())
                .joinToString("") { "%02x".format(it) }
                .take(32)
        }
    }

    /** Strings and numbers only; Analytics caps a string value at 100 chars. */
    @ReactMethod
    fun log(name: String, params: ReadableMap?) {
        val analytics = fa ?: return
        val bundle = Bundle()
        params?.let {
            val keys = it.keySetIterator()
            while (keys.hasNextKey()) {
                val key = keys.nextKey()
                when (it.getType(key)) {
                    ReadableType.String -> bundle.putString(key, it.getString(key)?.take(100))
                    ReadableType.Number -> bundle.putDouble(key, it.getDouble(key))
                    ReadableType.Boolean -> bundle.putString(key, it.getBoolean(key).toString())
                    else -> {}
                }
            }
        }
        runCatching { analytics.logEvent(name, bundle) }
    }

    /**
     * A JS error the app survived, as a Crashlytics non-fatal. The JS stack
     * becomes the report's stack, one frame per line, so different errors are
     * different issues instead of all sharing this method's native stack.
     */
    @ReactMethod
    fun recordError(message: String, stack: String?) {
        if (fa == null) return
        val frames = stack.orEmpty().lines().mapNotNull { line ->
            JS_FRAME.find(line)?.let { m ->
                StackTraceElement("JS", m.groupValues[1], "bundle", m.groupValues[2].toIntOrNull() ?: -1)
            }
        }
        val error = JsError(message.take(300)).apply {
            if (frames.isNotEmpty()) stackTrace = frames.toTypedArray()
        }
        runCatching { FirebaseCrashlytics.getInstance().recordException(error) }
    }

    private class JsError(message: String) : Exception(message)
}

/** "at name (… :line:column)" in a Hermes stack; the column is what locates
 *  code in a one-line release bundle. */
private val JS_FRAME = Regex("""at (\S+) \(.*?:\d+:(\d+)\)""")
