package com.musicplayer

import android.annotation.SuppressLint
import android.os.Bundle
import android.provider.Settings
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.google.firebase.analytics.FirebaseAnalytics
import java.security.MessageDigest

/**
 * Usage statistics, through Firebase (Google Analytics for apps).
 *
 * Firebase itself collects the basics with no code here: installs, active
 * users, sessions, app version, country and city (derived by Google from the
 * connection; the IP is never shown to us). This module adds the app's own
 * events (see src/analytics.ts) and one stable user id.
 *
 * The id is a hash of Android's per-app device id, so one phone stays one
 * user through reinstalls and "clear data", where Firebase's own id would
 * start over and count the same person twice. The raw device id never leaves
 * the phone.
 *
 * Off unless the build has a Firebase config: google-services.json is not in
 * the repo (CI writes it from a secret), so a contributor's or a fork's build
 * has no `google_app_id` and every call here is a no-op.
 */
class AnalyticsModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "Analytics"

    private val fa: FirebaseAnalytics? = runCatching {
        val configured =
            ctx.resources.getIdentifier("google_app_id", "string", ctx.packageName) != 0
        if (configured) {
            FirebaseAnalytics.getInstance(ctx).also { it.setUserId(stableId()) }
        } else {
            null
        }
    }.getOrNull()

    @SuppressLint("HardwareIds")
    private fun stableId(): String {
        val raw = Settings.Secure.getString(
            reactApplicationContext.contentResolver,
            Settings.Secure.ANDROID_ID,
        ) ?: return ""
        return MessageDigest.getInstance("SHA-256")
            .digest(raw.toByteArray())
            .joinToString("") { "%02x".format(it) }
            .take(32)
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
}
