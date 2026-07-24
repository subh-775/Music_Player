package com.musicplayer

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.DocumentsContract
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Hands the backend port and per-launch API token to JS as constants, so the RN
 * side never hardcodes the port (debug 8771 / release 8770, from BuildConfig)
 * and can authenticate every /api call. Constants are available synchronously at
 * bridge init, so the very first fetch already carries the token.
 *   import { NativeModules } from 'react-native';
 *   const { port, token } = NativeModules.Backend;
 *
 * Also hosts the download-folder picker: the system OpenDocumentTree screen,
 * translated back to a real filesystem path because yt-dlp and the tagger in
 * the Python backend need one — a content:// URI is no use to them.
 */
class BackendModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "Backend"

    private var folderPromise: Promise? = null

    private val activityListener: ActivityEventListener =
        object : BaseActivityEventListener() {
            override fun onActivityResult(
                activity: Activity?,
                requestCode: Int,
                resultCode: Int,
                data: Intent?,
            ) {
                if (requestCode != PICK_FOLDER) return
                val uri = if (resultCode == Activity.RESULT_OK) data?.data else null
                // "" tells JS the user backed out — not an error.
                folderPromise?.resolve(uri?.let { treeUriToPath(it) } ?: "")
                folderPromise = null
            }
        }

    init {
        reactContext.addActivityEventListener(activityListener)
    }

    override fun getConstants(): Map<String, Any> =
        mapOf(
            "port" to BuildConfig.BACKEND_PORT,
            "token" to PythonBackend.apiToken,
            "version" to (
                reactApplicationContext.packageManager
                    .getPackageInfo(reactApplicationContext.packageName, 0)
                    .versionName ?: ""
            ),
        )

    /** Open the system folder picker; resolves a real path, or "" on cancel. */
    @ReactMethod
    fun pickFolder(promise: Promise) {
        val activity = currentActivity
        if (activity == null) {
            promise.resolve("")
            return
        }
        folderPromise?.resolve("") // a second tap supersedes the first
        folderPromise = promise
        try {
            activity.startActivityForResult(
                Intent(Intent.ACTION_OPEN_DOCUMENT_TREE),
                PICK_FOLDER,
            )
        } catch (e: Exception) {
            folderPromise = null
            promise.resolve("")
        }
    }

    /**
     * content:// tree URI -> real filesystem path. Same translation the WebView
     * build shipped: the primary volume maps to the external storage root, any
     * other volume to /storage/<volume>.
     */
    private fun treeUriToPath(uri: Uri): String = try {
        val docId = DocumentsContract.getTreeDocumentId(uri)
        val parts = docId.split(":", limit = 2)
        val volume = parts.getOrNull(0) ?: ""
        val relative = parts.getOrNull(1) ?: ""
        val root = when {
            volume.equals("primary", ignoreCase = true) ->
                Environment.getExternalStorageDirectory().absolutePath
            volume.isNotBlank() -> "/storage/$volume"
            else -> ""
        }
        if (root.isBlank()) "" else if (relative.isBlank()) root else "$root/$relative"
    } catch (e: Exception) {
        ""
    }

    companion object {
        private const val PICK_FOLDER = 51423
    }
}
