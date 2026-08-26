package com.musicplayer

import android.app.Activity
import android.app.DownloadManager
import android.content.Context
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
                        if (uri != null) {
                            // Hold on to the grant, and to the URI itself.
                            //
                            // The PATH is what the Python backend needs (yt-dlp
                            // and the tagger cannot use a content:// URI), but
                            // the URI is the only thing that can later open the
                            // folder: a tree URI we hold a persisted grant on is
                            // the one form DocumentsUI will actually resolve for
                            // this caller. See openFolder.
                            try {
                                reactApplicationContext.contentResolver
                                    .takePersistableUriPermission(
                                        uri,
                                        Intent.FLAG_GRANT_READ_URI_PERMISSION or
                                            Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
                                    )
                                reactApplicationContext
                                    .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                                    .edit()
                                    .putString(KEY_TREE_URI, uri.toString())
                                    .apply()
                            } catch (e: Exception) {
                                Log.w(TAG, "could not persist folder grant: " + e.message)
                            }
                        }
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
     * The version this replaces looked right and could not work. Its first
     * candidate built a content://com.android.externalstorage.documents/... URI
     * by hand and set FLAG_GRANT_READ_URI_PERMISSION — but that flag grants
     * permission OUTWARD on a URI you own; it cannot give you access to another
     * app's provider. DocumentsUI resolves that intent (so startActivity
     * succeeds, so the loop returned true and never tried anything else) and
     * then cannot resolve the URI for this caller, so it opens at its own
     * default location. Which is exactly the report: the Files app opens, just
     * not there.
     *
     * The tree URI from the folder picker differs in the one way that matters —
     * we hold a persisted grant on it — so it goes first, and every candidate
     * now checks resolveActivity BEFORE launching so the chain can fall
     * through instead of stopping at its worst option.
     */
    @ReactMethod
    fun openFolder(path: String, promise: Promise) {
        val activity = currentActivity ?: reactApplicationContext
        val pm = reactApplicationContext.packageManager
        val root = Environment.getExternalStorageDirectory().absolutePath
        val rel = path.removePrefix(root).trim('/')

        val candidates = mutableListOf<Intent>()

        // 1. The folder the user picked, through the grant persisted with it.
        val saved = reactApplicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_TREE_URI, null)
        if (saved != null) {
            try {
                val tree = Uri.parse(saved)
                val docUri = DocumentsContract.buildDocumentUriUsingTree(
                    tree,
                    DocumentsContract.getTreeDocumentId(tree),
                )
                candidates.add(
                    Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(docUri, DocumentsContract.Document.MIME_TYPE_DIR)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    },
                )
            } catch (e: Exception) {
                Log.w(TAG, "saved tree uri unusable: " + e.message)
            }
        }

        // 2. The hand-built authority form. Kept, because some third-party file
        //    managers do resolve it against their own index — but no longer
        //    first, and no longer counted as success merely because something
        //    answered the intent.
        candidates.add(
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
        )

        // 3. The system Downloads screen. Not the folder, but it is where a
        //    default-path download actually lands, and it always works.
        if (path.contains("/Download", ignoreCase = true)) {
            candidates.add(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS))
        }

        // 4. Last resort: a file manager, anywhere at all.
        candidates.add(
            Intent(Intent.ACTION_VIEW).apply {
                type = DocumentsContract.Document.MIME_TYPE_DIR
            },
        )

        for ((i, intent) in candidates.withIndex()) {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            // Ask first. Letting startActivity throw as the test is what made
            // the chain stop at its worst option: that one never throws.
            //
            // Except on the LAST candidate, where a null answer is not proof of
            // anything: resolveActivity is filtered by package visibility, and
            // an OEM file manager outside the <queries> allowlist is invisible
            // to it. Trying and catching costs nothing at that point.
            val last = i == candidates.size - 1
            if (!last && intent.resolveActivity(pm) == null) {
                continue
            }
            try {
                activity.startActivity(intent)
                promise.resolve(true)
                return
            } catch (e: Exception) {
                Log.w(TAG, "openFolder candidate failed: " + e.message)
            }
        }
        promise.resolve(false)
    }

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
                // height > 0, not just non-null. This is called from Home, and
                // Home mounts while the splash is still up — at which point the
                // decor view frequently has no height yet. Rect(0, 0, px, 0)
                // excludes NOTHING, so Android kept the strip for its own back
                // gesture and ate the drawer swipe, silently and permanently:
                // the call had already "succeeded" and nothing ever retried it.
                // JS now calls this from onLayout, and this bails until there
                // is something real to measure.
                if (root != null && root.height > 0) {
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
        private const val PREFS = "mp.native.v1"

        /** The picked download folder as a tree URI we hold a persisted grant
         *  on. The PATH lives in JS settings; this is the only thing that can
         *  open that folder afterwards. */
        private const val KEY_TREE_URI = "downloadTreeUri"
        private const val PICK_FOLDER = 51423
        private const val PICK_IMAGE = 51424
    }
}
