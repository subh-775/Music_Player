"""
Android environment bootstrap.
==============================
Chaquopy runs CPython inside the app process, so there is no "user home",
no Music folder, and no writable CWD in the usual sense. Kotlin hands us the
concrete app directories at startup (see BackendService.kt) and this module
turns them into the paths the rest of the backend expects.

Import this BEFORE anything from components/ — it sets HOME, which several
components read via Path.home().
"""

import json
import os
import sys
from pathlib import Path

# Populated by configure() before the server starts.
_dirs = {
    "files": "",       # app-private internal storage (config, cookies, caches)
    "downloads": "",   # app-private EXTERNAL storage — the FALLBACK for audio
    "public": "",      # /storage/emulated/0/Download — the PREFERRED root
    "web": "",         # extracted React bundle served as the SPA
    "cache": "",
}

# The folder name we own inside the phone's public Download directory.
PUBLIC_SUBDIR = ("Fix_Spotify", "music")


def configure(
    files_dir: str,
    downloads_dir: str,
    web_dir: str,
    cache_dir: str,
    public_dir: str = "",
) -> None:
    """Called once from Kotlin with the real Android paths."""
    _dirs["files"] = files_dir
    _dirs["downloads"] = downloads_dir
    _dirs["public"] = public_dir
    _dirs["web"] = web_dir
    _dirs["cache"] = cache_dir

    for key in ("files", "downloads", "cache"):
        try:
            Path(_dirs[key]).mkdir(parents=True, exist_ok=True)
        except Exception:
            pass

    # components/ and api/main.py both use Path.home() for config + downloads.
    # Point it at app-private internal storage so those calls resolve to a real,
    # writable location instead of "/" (which is read-only on Android).
    os.environ["HOME"] = files_dir
    os.environ.setdefault("XDG_CACHE_HOME", cache_dir)

    # yt-dlp writes temp/part files next to the output, but its cache dir would
    # otherwise land somewhere unwritable.
    os.environ.setdefault("XDG_CONFIG_HOME", files_dir)

    # requests/certifi: Chaquopy ships certifi, but some transitive code reads
    # these env vars directly.
    try:
        import certifi
        os.environ.setdefault("SSL_CERT_FILE", certifi.where())
        os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())
    except Exception:
        pass

    # Android has no HTTP_PROXY notion by default; make sure a stale value from
    # the host environment can't break every outbound call.
    for var in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        os.environ.pop(var, None)


def files_dir() -> str:
    return _dirs["files"]


def _settings_path() -> Path:
    return Path(_dirs["files"] or ".") / "mobile_settings.json"


def read_settings() -> dict:
    try:
        return json.loads(_settings_path().read_text("utf-8"))
    except Exception:
        return {}


def write_settings(data: dict) -> None:
    try:
        _settings_path().write_text(json.dumps(data), "utf-8")
    except Exception:
        pass


def _writable(path: str) -> bool:
    """A directory is only usable if we can actually CREATE a file in it.

    os.access() lies under Android's scoped storage — it reports the public
    Download folder as writable even when the write will be refused — so probe
    for real rather than trusting it.
    """
    if not path:
        return False
    try:
        p = Path(path)
        p.mkdir(parents=True, exist_ok=True)
        probe = p / ".fixspotify_write_test"
        probe.write_bytes(b"")
        probe.unlink()
        return True
    except Exception:
        return False


def is_writable(path: str) -> bool:
    """Public probe — used by the API before accepting a custom folder."""
    return _writable(path)


def default_downloads_dir() -> str:
    """Downloads/Fix_Spotify/music — the phone's real, user-visible Download
    folder, so songs show up in any file manager and SURVIVE an uninstall.

    Empty when Android gave us no public Download path at all.
    """
    if _dirs["public"]:
        return str(Path(_dirs["public"], *PUBLIC_SUBDIR))
    return ""


def private_downloads_dir() -> str:
    """The always-writable last resort: app-private external storage. Invisible
    to file managers, and Android DELETES it on uninstall."""
    return _dirs["downloads"] or str(Path(_dirs["files"]) / "Music")


def downloads_dir() -> str:
    """Where downloaded audio is written.

    Order of preference:
      1. a custom folder the user picked in Settings
      2. Downloads/Fix_Spotify/music  (needs All-files access)
      3. the app-private external dir  (always writable, no permission, but
         invisible in file managers and WIPED on uninstall)

    (3) is a fallback, not a choice: without the permission Android simply
    refuses the write, and silently failing every download would be worse than
    putting the files somewhere less convenient.
    """
    custom = (read_settings().get("download_dir") or "").strip()
    if custom and _writable(custom):
        return custom

    preferred = default_downloads_dir()
    if preferred and _writable(preferred):
        return preferred

    fallback = private_downloads_dir()
    try:
        Path(fallback).mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    return fallback


def downloads_status() -> dict:
    """What the Settings screen shows: where files go, and whether we had to
    settle for somewhere the user would not have chosen.

    `using_fallback` means we landed in app-private storage — invisible to file
    managers and wiped on uninstall. That is the case the UI must warn about, so
    it is computed from where we ACTUALLY are, not from what was configured.
    """
    custom = (read_settings().get("download_dir") or "").strip()
    active = downloads_dir()
    preferred = default_downloads_dir()
    return {
        "path": active,
        "custom": custom or None,
        "default": preferred,
        "using_fallback": active == private_downloads_dir(),
        "public_writable": bool(preferred) and _writable(preferred),
    }


def web_dir() -> str:
    return _dirs["web"]


def cache_dir() -> str:
    return _dirs["cache"]


def is_android() -> bool:
    return bool(_dirs["files"])


def install_stdio_logging() -> None:
    """Chaquopy discards stdout/stderr unless redirected. Send both to logcat so
    `adb logcat -s FixSpotifyPy` shows Python tracebacks and Flask logs."""
    try:
        from java import jclass
        Log = jclass("android.util.Log")
    except Exception:
        return  # not running under Chaquopy (desktop test run) — leave stdio alone

    class _LogStream:
        def __init__(self, level):
            self._level = level
            self._buf = ""

        def write(self, text):
            self._buf += text
            while "\n" in self._buf:
                line, self._buf = self._buf.split("\n", 1)
                if line:
                    self._level("FixSpotifyPy", line)
            return len(text)

        def flush(self):
            if self._buf:
                self._level("FixSpotifyPy", self._buf)
                self._buf = ""

    sys.stdout = _LogStream(Log.i)
    sys.stderr = _LogStream(Log.e)
