package com.musicplayer

import android.content.ComponentName
import android.content.pm.PackageManager
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Switching the launcher icon.
 *
 * Every icon is an `activity-alias` in the manifest pointing at the same
 * MainActivity, so exactly one of them is enabled at a time and switching is
 * enabling the new one and disabling the rest. This is core framework — the
 * same two calls on every Android device since API 1, with nothing
 * vendor-specific about it.
 *
 * ## The ordering is not arbitrary
 *
 * The new alias is enabled BEFORE the old ones are disabled. The package
 * manager applies these one at a time and the process can be killed between
 * them; disabling first would leave a window in which the app has no launcher
 * entry at all, and if it died there the user would have no icon to tap and no
 * way back in to fix it. Enabling first means the worst case is two icons for a
 * moment, which a relaunch tidies up.
 *
 * ## DONT_KILL_APP, and what it does not promise
 *
 * Without the flag the system may terminate the process as the component
 * changes — which for a music player means the song stopping mid-play. With it,
 * the change is applied without a deliberate kill. It is not a guarantee: the
 * system is still free to reclaim the process, and some OEM launchers restart
 * themselves when their shortcut database changes.
 *
 * ## Why the app asks for a restart afterwards
 *
 * The switch itself takes effect immediately as far as the package manager is
 * concerned. Whether the LAUNCHER has noticed is another matter entirely, and
 * it varies: stock Android, Pixel Launcher and Nova update within a second or
 * two, One UI is usually prompt, while MIUI/HyperOS, ColorOS and Realme UI
 * cache the shortcut and frequently show the old icon until the launcher (or
 * the phone) restarts. Nothing an app can call forces that refresh, so the
 * honest thing is to say so and offer the restart rather than pretend.
 */
class IconModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    override fun getName() = "AppIcon"

    /** Manifest alias names, matching the `key` the JS side uses. */
    private val aliases = mapOf(
        "default" to ".Icon.Default",
        "midnight" to ".Icon.Midnight",
    )

    private fun component(alias: String) =
        ComponentName(ctx.packageName, ctx.packageName + alias)

    /** Which icon is live right now, so the UI can show it selected without
     *  keeping its own copy of the answer and drifting from reality. */
    @ReactMethod
    fun current(promise: Promise) {
        try {
            val pm = ctx.packageManager
            val on = aliases.entries.firstOrNull { (_, alias) ->
                pm.getComponentEnabledSetting(component(alias)) ==
                    PackageManager.COMPONENT_ENABLED_STATE_ENABLED
            }
            // DEFAULT rather than ENABLED for the first one: an alias that has
            // never been touched reports COMPONENT_ENABLED_STATE_DEFAULT and
            // takes its state from android:enabled in the manifest, so the
            // untouched install matches none of the above and is "default".
            promise.resolve(on?.key ?: "default")
        } catch (e: Exception) {
            Log.w(TAG, "current() failed: ${e.message}")
            promise.resolve("default")
        }
    }

    /**
     * Switch to `key`. Resolves true when the package manager accepted it.
     *
     * A no-op when that icon is already live — re-enabling the running alias
     * is a component change like any other, and some launchers respond to it
     * by dropping and re-adding the shortcut for nothing.
     */
    @ReactMethod
    fun set(key: String, promise: Promise) {
        val target = aliases[key]
        if (target == null) {
            promise.reject("unknown_icon", "No icon named $key")
            return
        }
        try {
            val pm = ctx.packageManager
            val already = pm.getComponentEnabledSetting(component(target)) ==
                PackageManager.COMPONENT_ENABLED_STATE_ENABLED
            if (already) {
                promise.resolve(false)
                return
            }
            // ENABLE FIRST — see the note above. There must never be a moment
            // with no launcher entry.
            pm.setComponentEnabledSetting(
                component(target),
                PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                PackageManager.DONT_KILL_APP,
            )
            for ((k, alias) in aliases) {
                if (k == key) continue
                pm.setComponentEnabledSetting(
                    component(alias),
                    PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                    PackageManager.DONT_KILL_APP,
                )
            }
            Log.i(TAG, "launcher icon -> $key")
            promise.resolve(true)
        } catch (e: Exception) {
            Log.w(TAG, "set($key) failed: ${e.message}")
            promise.reject("icon_failed", e.message, e)
        }
    }

    /**
     * Relaunch the app, so the launcher re-reads its shortcut.
     *
     * Nothing an app can call forces a launcher to refresh its icon cache, and
     * on the ROMs that cache hardest a relaunch is the cheapest thing that
     * usually does it. This stops playback — the process really does end — so
     * it is only ever reached from a confirmation the user pressed themselves.
     *
     * The new task is started BEFORE the process ends, and CLEAR_TASK drops the
     * old back stack so the app comes up on Home rather than resuming into
     * whatever screen was open when it died.
     */
    @ReactMethod
    fun restart(promise: Promise) {
        try {
            val intent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
            if (intent == null) {
                promise.resolve(false)
                return
            }
            intent.addFlags(
                android.content.Intent.FLAG_ACTIVITY_NEW_TASK or
                    android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK,
            )
            ctx.startActivity(intent)
            promise.resolve(true)
            // A beat, so the promise and the new task both get away before the
            // process this is running in stops existing.
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                Runtime.getRuntime().exit(0)
            }, 300)
        } catch (e: Exception) {
            Log.w(TAG, "restart failed: ${e.message}")
            promise.resolve(false)
        }
    }

    companion object {
        private const val TAG = "AppIcon"
    }
}
