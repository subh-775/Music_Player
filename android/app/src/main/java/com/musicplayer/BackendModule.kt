package com.musicplayer

import android.app.Activity
import android.content.Intent
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.util.Log
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
    private var imagePromise: Promise? = null

    private val activityListener: ActivityEventListener =
        object : BaseActivityEventListener() {
            override fun onActivityResult(
                activity: Activity?,
                requestCode: Int,
                resultCode: Int,
                data: Intent?,
            ) {
                when (requestCode) {
                    PICK_FOLDER -> {
                        val uri = if (resultCode == Activity.RESULT_OK) data?.data else null
                        // "" tells JS the user backed out — not an error.
                        folderPromise?.resolve(uri?.let { treeUriToPath(it) } ?: "")
                        folderPromise = null
                    }
                    PICK_IMAGE -> {
                        val uri = if (resultCode == Activity.RESULT_OK) data?.data else null
                        if (uri != null) {
                            // Keep read access across restarts — the playlist
                            // cover must still load next launch.
                            try {
                                reactApplicationContext.contentResolver
                                    .takePersistableUriPermission(
                                        uri, Intent.FLAG_GRANT_READ_URI_PERMISSION,
                                    )
                            } catch (_: Exception) {}
                        }
                        imagePromise?.resolve(uri?.toString() ?: "")
                        imagePromise = null
                    }
                }
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

    /** Pick an image (playlist cover). Resolves a persistable content:// URI —
     *  RN's <Image> renders those directly — or "" on cancel. */
    @ReactMethod
    fun pickImage(promise: Promise) {
        val activity = currentActivity
        if (activity == null) {
            promise.resolve("")
            return
        }
        imagePromise?.resolve("")
        imagePromise = promise
        try {
            activity.startActivityForResult(
                Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "image/*"
                },
                PICK_IMAGE,
            )
        } catch (e: Exception) {
            imagePromise = null
            promise.resolve("")
        }
    }

    /**
     * Open the downloads folder in whatever file browser the device has.
     *
     * There is no universal "show me this directory" intent on Android, so this
     * tries the documented forms in order and falls back to launching a file
     * manager. Resolves false when nothing on the device can handle it, so the
     * UI can say so rather than appearing to do nothing.
     */
    @ReactMethod
    fun openFolder(path: String, promise: Promise) {
        val activity = currentActivity ?: reactApplicationContext
        val root = Environment.getExternalStorageDirectory().absolutePath
        val rel = path.removePrefix(root).trim('/')
        val treeUri = Uri.parse(
            "content://com.android.externalstorage.documents/document/primary%3A" +
                Uri.encode(rel),
        )
        val candidates = listOf(
            // The directory MIME type is what DocumentsUI and most third-party
            // file managers actually register for; the generic one below is a
            // fallback for those that don't.
            Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(treeUri, "vnd.android.document/directory")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            },
            // DocumentsUI's authority form — the one that actually lands on the
            // right folder when the device ships a documents provider.
            Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(
                    Uri.parse(
                        "content://com.android.externalstorage.documents/document/primary%3A" +
                            Uri.encode(rel),
                    ),
                    DocumentsContract.Document.MIME_TYPE_DIR,
                )
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            },
            Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(Uri.parse("file://$path"), "resource/folder")
            },
            // Last resort: open a file manager anywhere at all.
            Intent(Intent.ACTION_VIEW).apply {
                type = DocumentsContract.Document.MIME_TYPE_DIR
            },
        )
        for (intent in candidates) {
            try {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                activity.startActivity(intent)
                promise.resolve(true)
                return
            } catch (_: Exception) {
                // No app for this form — try the next.
            }
        }
        promise.resolve(false)
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

    /**
     * Ask Android not to claim a strip at the left edge for its own back
     * gesture, so the app's drawer pull can live there.
     *
     * Without this, an edge-swipe drawer is unreachable on any device with
     * gesture navigation on. The system reserves roughly the outer 20-24dp of
     * each edge and intercepts those touches BEFORE the app's view hierarchy
     * sees them — so a pull that starts inside the strip goes to system back,
     * and one that starts outside it is not in the strip at all. There is no
     * width that works: too narrow to hit, or fighting the system for most of
     * it.
     *
     * Android allows up to 200dp of exclusion per edge and silently ignores the
     * excess; 28dp is well inside that, so nothing here is discarded.
     *
     * API 29+. On 28 and below there is no gesture navigation to yield, so
     * `false` here means "not needed", not "failed".
     */
    @ReactMethod
    fun setEdgeExclusion(widthDp: Int, promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            promise.resolve(false)
            return
        }
        val activity = currentActivity
        if (activity == null) {
            promise.resolve(false)
            return
        }
        activity.runOnUiThread {
            try {
                val root = activity.window?.decorView
                if (root != null) {
                    val density = reactApplicationContext.resources.displayMetrics.density
                    val px = (widthDp * density).toInt()
                    // Height comes from the decor view rather than from a
                    // measured RN view: the strip is full-height by
                    // construction, and reading it here means the exclusion
                    // cannot go stale against a JS layout that has not
                    // re-reported yet.
                    root.systemGestureExclusionRects =
                        listOf(Rect(0, 0, px, root.height))
                }
            } catch (e: Exception) {
                Log.w(TAG, "could not set edge exclusion: " + e.message)
            }
        }
        promise.resolve(true)
    }

    companion object {
        private const val TAG = "BackendModule"
        private const val PICK_FOLDER = 51423
        private const val PICK_IMAGE = 51424
    }
}
