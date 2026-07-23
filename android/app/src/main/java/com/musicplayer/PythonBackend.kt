package com.musicplayer

import android.content.Context
import android.os.Environment
import android.util.Log
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.io.File
import kotlin.concurrent.thread

/**
 * Starts the embedded Python backend (Chaquopy) once per process.
 *
 * This is the same Flask server the Fix-Spotify app runs; the React Native UI
 * talks to it over http://127.0.0.1:<port>, exactly as the old WebView did.
 * start_server() blocks in serve_forever(), so it runs on its own daemon thread.
 *
 * Skeleton note: the API token is left empty, which DISABLES the loopback auth
 * gate (see _require_token in mobile_server.py). That is fine for a debug build
 * on your own phone over USB; the token + a native accessor get added before any
 * release, so another app on the device can't drive the backend.
 */
object PythonBackend {
    private const val TAG = "MPBackend"

    @Volatile private var started = false

    fun start(context: Context, port: Int) {
        if (started) return
        started = true

        val app = context.applicationContext
        if (!Python.isStarted()) {
            Python.start(AndroidPlatform(app))
        }

        val filesDir = app.filesDir.absolutePath
        val downloadsDir = File(app.getExternalFilesDir(null) ?: app.filesDir, "Music")
            .apply { mkdirs() }.absolutePath
        // The backend still expects a web dir (it can serve an SPA); RN doesn't
        // use those routes, so an empty dir is enough to satisfy the arg.
        val webDir = File(app.filesDir, "web").apply { mkdirs() }.absolutePath
        val cacheDir = app.cacheDir.absolutePath
        val publicDir = Environment
            .getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            ?.absolutePath ?: ""

        thread(name = "python-backend", isDaemon = true) {
            try {
                Log.i(TAG, "starting Python backend on 127.0.0.1:$port")
                Python.getInstance()
                    .getModule("mobile_server")
                    .callAttr(
                        "start_server",
                        filesDir, downloadsDir, webDir, cacheDir,
                        port, publicDir, ""
                    )
                Log.i(TAG, "Python backend stopped")
            } catch (e: Exception) {
                Log.e(TAG, "Python backend crashed", e)
            }
        }
    }
}
