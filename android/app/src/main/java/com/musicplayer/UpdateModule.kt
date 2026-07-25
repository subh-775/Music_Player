package com.musicplayer

import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * In-app updates for the sideloaded APK — ported from the WebView build.
 *
 * The app isn't on Play Store, so nothing updates it on its own. This asks
 * GitHub for the latest release, and if it's newer, downloads the attached APK
 * and hands it to Android's package installer (the user still confirms).
 *
 * It's an UPDATE, not a reinstall: Android only treats a new APK as an update
 * when the applicationId AND signing key match, and an update keeps the app's
 * data (likes, playlists, resume point). That's why the release keystore must be
 * stable — with it, updating is lossless.
 *
 * Events to JS (never throws — a failed check must not disturb playback):
 *   mp.update.result   {available, version, notes}
 *   mp.update.progress  number 0..100, or -1 on failure
 */
class UpdateModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    override fun getName() = "Updater"

    private var pending: Release? = null

    data class Release(val version: String, val apkUrl: String, val notes: String)

    private fun emit(event: String, data: Any?) {
        try {
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(event, data)
        } catch (_: Exception) {}
    }

    @ReactMethod
    fun check(promise: com.facebook.react.bridge.Promise?) {
        Thread {
            val rel = doCheck()
            pending = rel
            val map: WritableMap = Arguments.createMap().apply {
                putBoolean("available", rel != null)
                putString("version", rel?.version ?: "")
                putString("notes", rel?.notes ?: "")
            }
            emit("mp.update.result", map)
            promise?.resolve(rel != null)
        }.start()
    }

    @ReactMethod
    fun install() {
        val rel = pending
        if (rel == null) {
            emit("mp.update.progress", -1)
            return
        }
        Thread { downloadAndInstall(rel) }.start()
    }

    private fun doCheck(): Release? = try {
        val conn = (URL(RELEASES_API).openConnection() as HttpURLConnection).apply {
            connectTimeout = 8000
            readTimeout = 8000
            setRequestProperty("Accept", "application/vnd.github+json")
        }
        if (conn.responseCode != 200) {
            null
        } else {
            val json = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
            conn.disconnect()
            val tag = json.optString("tag_name").removePrefix("v")
            val assets = json.optJSONArray("assets")
            var apkUrl = ""
            if (assets != null) {
                for (i in 0 until assets.length()) {
                    val a = assets.getJSONObject(i)
                    if (a.optString("name").endsWith(".apk", ignoreCase = true)) {
                        apkUrl = a.optString("browser_download_url")
                        break
                    }
                }
            }
            val installed = ctx.packageManager
                .getPackageInfo(ctx.packageName, 0).versionName ?: "0"
            if (apkUrl.isNotBlank() && isNewer(tag, installed)) {
                Release(tag, apkUrl, json.optString("body"))
            } else {
                null
            }
        }
    } catch (e: Exception) {
        Log.w(TAG, "update check failed: ${e.message}")
        null
    }

    /** "1.10.0" must beat "1.9.0", so compare numerically part-by-part. */
    private fun isNewer(remote: String, installed: String): Boolean {
        fun parts(v: String) = v.trim().split(".", "-")
            .mapNotNull { it.takeWhile(Char::isDigit).toIntOrNull() }
        val r = parts(remote)
        val i = parts(installed)
        for (n in 0 until maxOf(r.size, i.size)) {
            val a = r.getOrElse(n) { 0 }
            val b = i.getOrElse(n) { 0 }
            if (a != b) return a > b
        }
        return false
    }

    private fun downloadAndInstall(release: Release) {
        try {
            val out = File(ctx.cacheDir, "update.apk")
            if (out.exists()) out.delete()
            val conn = (URL(release.apkUrl).openConnection() as HttpURLConnection).apply {
                connectTimeout = 15000
                readTimeout = 30000
                instanceFollowRedirects = true
            }
            val total = conn.contentLength.toLong()
            var read = 0L
            var lastPct = -1
            conn.inputStream.use { input ->
                out.outputStream().use { output ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        output.write(buf, 0, n)
                        read += n
                        if (total > 0) {
                            val pct = ((read * 100) / total).toInt()
                            if (pct != lastPct) {
                                lastPct = pct
                                emit("mp.update.progress", pct)
                            }
                        }
                    }
                }
            }
            conn.disconnect()
            emit("mp.update.progress", 100)

            val uri: Uri = FileProvider.getUriForFile(
                ctx, "${ctx.packageName}.fileprovider", out,
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            ctx.startActivity(intent)
        } catch (e: Exception) {
            Log.e(TAG, "update download failed: ${e.message}")
            emit("mp.update.progress", -1)
        }
    }

    companion object {
        private const val TAG = "MusicPlayerUpd"
        private const val RELEASES_API =
            "https://api.github.com/repos/subh-775/Music_Player/releases/latest"
    }
}
