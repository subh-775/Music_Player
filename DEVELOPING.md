# Developing without reinstalling an APK

Installing a fresh release APK for every UI tweak is the slow path. Use it only
when you actually need to test the release build (R8, the updater, signing).

For everything else there is a **debug APK you install once**. It carries no JS
bundle — it pulls the bundle from Metro on the PC over the USB cable, so a saved
edit shows up on the phone in about a second.

The debug build has `applicationId com.musicplayer.debug` and its own backend
port (8771), so it installs **alongside** the release app. They do not conflict
and they do not share data.

## One-time setup

1. Phone: **Developer options → USB debugging** on, plug into the PC, accept the
   "Allow USB debugging?" prompt.
2. GitHub → Actions → **Build Android APK** → Run workflow → branch `mobile`,
   variant **`debug`**. Download `Music_Player-debug.apk` and install it.

## Every session after that

```bash
npm run dev
```

That finds `adb`, points the phone's `localhost:8081` at the PC's Metro
(`adb reverse`), and starts Metro. Open the debug app and it loads the JS from
your working tree.

Now edit any `.ts`/`.tsx` file and save. Fast Refresh applies it immediately —
no rebuild, no reinstall.

Dev menu (reload, performance monitor, element inspector): shake the phone, or

```bash
adb shell input keyevent 82
```

## What still needs a rebuild

Only two things:

- **Kotlin** — `AudioModule.kt`, `BackendModule.kt`, `UpdateModule.kt`,
  `MainActivity.kt`, anything under `android/`.
- **Python** — `mobile_server.py` and `components/`, because Chaquopy packages
  the interpreter and sources into the APK.

Everything in `src/` and `App.tsx` is hot.

## Reading logs

The app mirrors its own event log to logcat:

```bash
adb logcat -s MPJS
```

`MPJS` carries every `diag()` call — boot, playback failures, the equalizer, the
updater. For native and crashes:

```bash
adb logcat -s MPJS AudioModule PlaybackSession Updater AndroidRuntime:E
```

An empty `MPJS` capture means the logging is broken, not the thing you are
chasing — boot always writes a line.

## Release build

Still needed to verify anything R8 touches, and it is what ships:

- Actions → Run workflow → variant `release` (a test build; its version is the
  latest tag with the patch bumped, so it installs over what is on the phone).
- Or push a `v*` tag, which builds the real release and attaches it to a GitHub
  Release.
