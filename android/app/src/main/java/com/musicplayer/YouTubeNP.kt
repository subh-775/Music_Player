package com.musicplayer

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import org.schabi.newpipe.extractor.search.SearchInfo
import org.schabi.newpipe.extractor.stream.StreamInfo
import org.schabi.newpipe.extractor.stream.StreamInfoItem
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * YouTube search + audio-stream resolution, via NewPipeExtractor.
 *
 * Why this exists (and why yt-dlp does NOT do YouTube on this platform):
 * since late 2025 YouTube gates stream URLs behind a JS signature + throttling
 * ("n") challenge. yt-dlp solves it with an external JS runtime — Deno on the
 * desktop — and Android has none. Three attempts to graft a JS engine into
 * yt-dlp's provider framework (WebView, app.cash.quickjs, quickjs-ng) all failed
 * on-device.
 *
 * NewPipeExtractor solves the same problem natively: it bundles Rhino and does
 * the deobfuscation itself. Pure Java, no Python, no cookies. Both this repo and
 * NewPipeExtractor are GPLv3, so linking it is licence-compatible.
 *
 * Python (mobile/python/newpipe_yt.py) calls these three static methods and gets
 * JSON back — deliberately the narrowest possible bridge, so the extractor's
 * types never have to cross into Chaquopy.
 */
object YouTubeNP {

    private const val TAG = "MusicPlayerNP"

    @Volatile private var started = false

    /** A minimal Downloader on HttpURLConnection — avoids pulling in OkHttp. */
    private class SimpleDownloader : Downloader() {
        @Throws(IOException::class)
        override fun execute(request: Request): Response {
            val conn = (URL(request.url()).openConnection() as HttpURLConnection).apply {
                requestMethod = request.httpMethod()
                connectTimeout = 15_000
                readTimeout = 20_000
                instanceFollowRedirects = true
            }
            request.headers().forEach { (name, values) ->
                // Replace, don't append: NewPipe hands us the full header value set.
                conn.setRequestProperty(name, values.firstOrNull() ?: "")
                values.drop(1).forEach { conn.addRequestProperty(name, it) }
            }

            val body = request.dataToSend()
            if (body != null) {
                conn.doOutput = true
                conn.outputStream.use { it.write(body) }
            }

            val code = conn.responseCode
            // A 4xx/5xx has no inputStream — the payload is on errorStream, and
            // NewPipe needs to SEE it (that's how it detects a captcha/age gate).
            val text = try {
                (if (code >= 400) conn.errorStream else conn.inputStream)
                    ?.bufferedReader()?.use { it.readText() } ?: ""
            } catch (e: Exception) {
                ""
            }

            return Response(
                code,
                conn.responseMessage ?: "",
                conn.headerFields.filterKeys { it != null },
                text,
                conn.url.toString(),
            ).also { conn.disconnect() }
        }
    }

    /** One-time init. Safe to call repeatedly. */
    private fun ensureStarted(): Boolean {
        if (started) return true
        synchronized(this) {
            if (started) return true
            return try {
                NewPipe.init(SimpleDownloader())
                started = true
                true
            } catch (e: Throwable) {
                Log.e(TAG, "NewPipe init failed", e)
                false
            }
        }
    }

    /** True when the extractor is usable on this device. */
    @JvmStatic
    fun isSupported(): Boolean = ensureStarted()

    /**
     * Search YouTube. Returns a JSON array of
     * [{title, artist, duration_ms, url, artwork}], or "[]".
     */
    @JvmStatic
    fun search(query: String, limit: Int): String {
        if (!ensureStarted()) return "[]"
        return try {
            val yt = ServiceList.YouTube
            val info = SearchInfo.getInfo(
                yt,
                yt.searchQHFactory.fromQuery(query, listOf("videos"), ""),
            )
            val out = JSONArray()
            for (item in info.relatedItems) {
                if (item !is StreamInfoItem) continue
                if (out.length() >= limit) break
                // duration is SECONDS here; <=0 means live/unknown — unplayable.
                val secs = item.duration
                if (secs <= 0) continue
                out.put(
                    JSONObject()
                        .put("title", item.name ?: "")
                        .put("artist", item.uploaderName ?: "")
                        .put("duration_ms", secs * 1000L)
                        .put("url", item.url ?: "")
                        .put("artwork", firstThumbnail(item)),
                )
            }
            out.toString()
        } catch (e: Throwable) {
            Log.w(TAG, "search failed: $query", e)
            "[]"
        }
    }

    /**
     * Best audio-only stream for a watch URL (or video id). Returns a JSON object
     * {url, bitrate_kbps, codec} — or {} when nothing is playable.
     */
    @JvmStatic
    fun streamUrl(videoUrlOrId: String): String {
        if (!ensureStarted()) return "{}"
        return try {
            val url = if (videoUrlOrId.startsWith("http")) videoUrlOrId
            else "https://www.youtube.com/watch?v=$videoUrlOrId"

            val info = StreamInfo.getInfo(ServiceList.YouTube, url)
            // Highest-bitrate audio-only track. NewPipe has already deobfuscated
            // the signature and the throttling parameter by this point.
            val best = info.audioStreams
                .filter { !it.url.isNullOrBlank() }
                .maxByOrNull { it.averageBitrate }
                ?: return "{}"

            JSONObject()
                .put("url", best.url)
                .put("bitrate_kbps", if (best.averageBitrate > 0) best.averageBitrate / 1000 else 0)
                .put("codec", best.format?.getName() ?: "")
                .toString()
        } catch (e: Throwable) {
            Log.w(TAG, "streamUrl failed: $videoUrlOrId", e)
            "{}"
        }
    }

    /** Thumbnail URL, tolerating API shape changes across extractor versions. */
    private fun firstThumbnail(item: StreamInfoItem): String = try {
        item.thumbnails.maxByOrNull { it.height }?.url ?: ""
    } catch (e: Throwable) {
        ""
    }
}
