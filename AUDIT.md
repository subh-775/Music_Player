# Security & performance audit — for the next release

Audit of `mobile` at `a839945`, covering the React Native app, the embedded
Python/Flask backend, the Kotlin native modules and the Android build.

Nine previous audit rounds went into **behaviour** — what the app does wrong.
This one is about **cost**: what the app spends while nobody is listening, what
it reads before it can draw a frame, and what it will accept from the network.

Everything marked **Fixed** is in `ff5e23f` and **shipped in v1.2.2**, verified
(tsc clean, 37 tests pass, eslint unchanged at 199 problems / 4 errors — all
pre-existing, all in `docs/`). Everything marked **Proposed** needs a decision, a
device, or both, and is deliberately left uncommitted.

> **S1 is not in v1.2.2.** That release is still signed with the debug key, like
> every one before it. See below for why it is a release-planning decision rather
> than a patch.

| Severity | Count | Fixed in `ff5e23f` | Proposed |
|---|---|---|---|
| 🔴 Critical | 1 | — | S1 |
| 🟠 Major | 8 | S2, S3, P1, P2, P6, P7 | P3, P12 |
| 🟡 Minor | 10 | S7, P8, P9 | S4, S5, S6, P4, P5, P10, P11 |
| ⚪ Watch | 2 | W1 | W2 |
| **Total** | **21** | **10** | **11** |

---

## The one that matters most

### S1 🔴 Every release is signed with the public Android debug key — **Proposed**

`android/app/build.gradle` signs the **release** build type with
`signingConfigs.debug`, and CI runs `assembleRelease` (`build-android.yml:98`),
so every published APK carries it. That keystore is committed at
`android/app/debug.keystore`, and it is not merely *a* checked-in key — it is
**the** Android debug key, byte-identical to the one in every React Native
project ever generated:

```
Owner:  CN=Android Debug, OU=Android, O=Unknown, L=Unknown, ST=Unknown, C=US
SHA1:   5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25
Signature algorithm: SHA1withRSA (weak)
```

Android decides that one APK may replace another — keeping its data directory,
its UID and its granted permissions — when the `applicationId` **and the
signing key** match. Both are public here. Anyone can build an APK declaring
`com.musicplayer`, sign it with a key they already have, and hand it to a user
as a Relaxify update; the installer will accept it as genuine and it will
inherit the library, the download folder and the app's permissions.

This also removes the backstop under the whole update path. The signature check
is what makes "download an APK from the internet and install it" tolerable, and
here it checks a key anyone can produce.

**The fix, and why it is not in this commit.** Generate a real release keystore,
hold it in GitHub Secrets as base64, decode it in CI, and sign with it. That is
half an hour of work. The problem is the other half: **a signing-key change is a
one-way door.** Existing installs cannot update across it. Every current user
must uninstall and reinstall, losing anything not on disk, and no amount of
cleverness in the updater avoids that — it is enforced below us, by the package
manager.

So this is a release-planning decision, not a patch:

1. Do it in the **next** release, not a later one. The population stranded by
   the cutover only grows, and every release shipped under the debug key is
   another one an attacker can impersonate.
2. Ship the cutover release with loud release notes and an in-app notice: this
   update must be installed manually, and here is what to expect.
3. Consider writing an export of likes/playlists to the (already user-visible)
   download folder in the release **before** the cutover, so there is something
   to restore from.
4. Never commit the new keystore. `android/app/debug.keystore` should keep
   signing debug builds and nothing else.

---

## Security

### S2 🟠 The updater trusted any URL the release JSON named — **Fixed**

`UpdateModule.doCheck()` read `browser_download_url` straight out of the API
response and `downloadAndInstall()` fetched it and handed the result to the
package installer. Nothing checked the scheme or the host, and redirects were
followed, so wherever that field pointed is where the APK came from.

Now: HTTPS and a GitHub host only (`github.com`, `*.githubusercontent.com`),
checked on the asset URL **and again on the URL the connection settled on**,
because following redirects means the second is the one that matters.

The asset size GitHub already reports is verified as well. That check is not
really about attack — it catches the download that died at 90%, which today
reaches the user as the installer's "App not installed" with no reason given.

### S3 🟠 Wildcard CORS let any web page fingerprint the app — **Fixed**

`_cors()` set `Access-Control-Allow-Origin: *` on every response, including the
ungated `/health`. Loopback is not private on Android and is reachable from the
device's own browser, so **any page the user visited** could fetch
`http://127.0.0.1:8770/health` and read the reply — a reliable "this person has
Relaxify installed" signal and a port oracle for whatever else is listening.

`/api/*` was never exposed: the token gate holds and `hmac.compare_digest` is
the correct comparison. This was disclosure, not control — but it bought
nothing. The RN client is not a browser and never preflights; the only caller
that needs these headers is a desktop browser on `adb forward`, which is exactly
the run with no token set. They are scoped to that now.

### S4 🟡 `/health` is still unauthenticated — **Proposed**

With S3 fixed a page can no longer *read* the response, but it can still infer
the app's presence from whether the request succeeds at all. Gating `/health`
closes it completely. Two callers to update (`waitForBackend` and
`warnIfEngineStopped`, both in `backend.ts`) — the reason it was not done here
is that `waitForBackend` runs on the boot path and a mistake there is a hang at
the splash, which deserves a device to test on.

### S5 🟡 `proxy_stream` is a token-gated open proxy — **Proposed**

`url` and `source` are caller-controlled and nothing constrains the host, so
anything holding the token can use the app as an HTTP proxy. The token is the
only thing in the way, and it rides in **query strings** — the most log-prone
place to put a secret. Allowlist the resolved stream host to the known CDNs, and
prefer the `X-Fix-Token` header for every call that can set one (only
`<audio src>`-style URLs genuinely cannot).

### S6 🟡 Hardcoded shared Last.fm API key — **Proposed**

`components/radio.py:32` falls back to `b25b959554ed76058ac220b7b2e0a026`, a key
published in countless tutorials and shared by thousands of clients. It is not a
leak of anything of the user's, but radio degrades silently when it gets
rate-limited or revoked, and the failure will look like a bug in the app. Get a
project key, ship it through the build, keep the env override.

### S7 🟡 Python dependencies were unpinned — **Fixed**

`yt-dlp>=2026.7.4` and `requests>=2.31.0` were floors, so no two CI builds
resolved the same tree: APK contents and size drifted release to release, a
field report could not be tied to a known set of bytes, and a broken upstream
publish would have shipped itself with no change on our side. All four are
pinned; bump them in a commit where the diff is reviewable.

**Reviewed and found sound**, for the record: the `/api/*` token gate and its
constant-time compare; path confinement on `/api/local` and `/api/local/artwork`
(`resolve(strict=True)` plus a `parents` check, extension allowlist);
`network_security_config` (cleartext scoped to loopback, everything else
TLS-only); `allowBackup="false"`; the `FileProvider` (not exported, URI grants);
no `shell=True` anywhere; no secrets in the JS bundle.

---

## Load time

### P1 🟠 Sixteen sequential AsyncStorage reads before the first frame — **Fixed**

`hydrateAll()` mapped every store to its own `getItem`, so a cold start made
sixteen bridge crossings and sixteen SQLite queries, all queued behind the same
single-threaded native module, before the UI could settle. It is one `multiGet`
now. The per-store path is kept as the fallback: a slow start is bad, an empty
library looks like the app ate your data.

### P2 🟠 The Home render cache grew without limit — **Fixed**

`mp.homeRows.v1` stored whatever the backend returned — every row, every item,
each carrying a full `artwork_urls` map — and the whole blob was `JSON.parse`'d
on the JS thread during every cold start, before the first frame.

**This is the most likely answer to "load time increased over time."** Nothing
trimmed it, so it grew as the catalogue behind it got richer, and it sat
directly on the path the splash was waiting for. Now capped at 4 rows × 12 items
on the way in *and* on the way out; what is on screen stays whole.

### P3 🟠 Every screen is imported eagerly — **Proposed**

`App.tsx` statically imports all eleven screens — `PlayerScreen` (1,603 lines),
`SettingsScreen` (1,265), `CollectionScreen` (810), `SearchScreen` (649),
`LibraryScreen` (618), `EqualizerScreen` (504), `QueueScreen` (467),
`ActivityScreen` (358), `ArtistScreen` (334), `SpotifyImportScreen` (273) —
roughly 6,900 lines of screen code that Hermes must load and evaluate before the
first frame, for screens most sessions never open.

Every one of them is already mounted from a state flag, so this is mechanical:
`React.lazy` behind the existing `<Splash>`, or a plain `require()` on first
open. Expect the largest single cut to time-to-interactive available here. Left
out of this commit because it wants a device and a stopwatch, not a typecheck.

### P4 🟡 The splash can hold for six seconds — **Proposed**

`bootCap` waits for the engine **and** Home's first rows, up to 6s. With P2
fixed, cached rows are available almost immediately — so show the shell as soon
as the engine resolves and let Home fill in underneath. The cap becomes a
backstop rather than a routine wait.

### P5 🟡 Backend warm-up competes with the first frame — **Proposed**

`_warm_up()` constructs every search client on a thread the moment Flask boots,
and `_restore_youtube()` runs before the first request is served. Both land on
the same small CPU the UI is using to draw. Defer the warm-up until after the
first successful `/health`, or drop it — its benefit is one avoided lazy import
on a path the user reaches seconds later anyway.

---

## "The app feels heavier"

### P6 🟠 The watcher never idled — **Fixed** *(the single biggest win here)*

`startCrossfadeWatcher` is started at boot and never cleared, and the process
outlives the UI **by days** behind the `mediaPlayback` foreground service. Every
tick, once a second, for that entire lifetime, regardless of whether anything
was playing, it ran:

| Per tick | Bridge calls |
|---|---|
| `topUpFromRadio()` → `getQueue` (marshals the **entire queue**) + `getActiveTrackIndex` | 2 |
| `prefetchNext()` → `getProgress` + `getActiveTrackIndex` | 2 |
| resume save → `getProgress` + `getActiveTrackIndex` + `getActiveTrack` | 3 |

Seven bridge round trips a second, one of them O(queue length), while the phone
sat in a pocket. The `AppState` check that might have stopped it came *after*
all of the above.

One playback-state read now gates the lot: idle, the tick costs a single call
and returns; playing, nothing changes. The falling edge keeps the one thing the
old tick was silently providing — a resume position captured at the moment of
the pause — and now writes it *exactly*, rather than within four seconds of it
by luck of `saveResume`'s throttle.

### P7 🟠 500×500 covers drawn at 52dp — **Fixed**

`normalizeTrack` bakes `getBestArtworkUrl` into every track, which rewrites any
size-templated URL up to `500x500` (or iTunes `600x600bb`). That is right for
the player and for a Home card. `TrackRow` draws it at **52dp** and
`DownloadRow` at 46dp — even at 3× density, roughly ten times the pixels
actually drawn, downloaded and decoded and held in the bitmap cache **per row**,
for every row on screen and every row the virtualiser keeps warm. On a long
library that is the difference between a few megabytes of bitmaps and tens.

Both catalogues template the size into the path, so `thumbArtwork()` asks for
`150x150` / `200x200bb` and costs nothing. Six tests cover it, including the
regex backtracking case (`200x200bb` → `200x20`) that the single-pass form
exists to prevent.

`PlayerBar` (54dp) is deliberately **left alone**: its cover is already
prefetched into the image cache by `player.ts`, and the same URL feeds
`useArtworkColor`, so shrinking it would add a second fetch and risk the mini
player's tint disagreeing with the full player's. Worth doing, but only together
with `PlayerScreen`, and that is a visual decision.

### P8 🟡 Store writes were serialised on every mutation — **Fixed**

`persist()` did a full `JSON.stringify` of the whole store, synchronously on the
JS thread, on every `set`/`update`. One play rewrites the recents list **and**
the stats blob (up to 300 tracks, 200 artists, 700 log entries) mid-render. Now
debounced at 250ms with a `flushAll()` when the app leaves the foreground.

### P9 🟡 `diag()` allocated on every log line — **Fixed**

The module's own docstring says it "costs nothing when nobody opens the
Diagnostics screen." It did not: every call allocated a 200-element copy and
reversed it, subscribed or not, from the play, update and boot paths. It marks
the snapshot stale and rebuilds in `readDiag()`.

### P10 🟡 `useAudioOutput` polls native every 1.5s — **Proposed**

For an event — a headset connecting — that happens perhaps twice a day, whenever
the player bar is mounted, which is whenever anything has played. Replace with
`AudioManager.registerAudioDeviceCallback` on the native side and an emit, or at
minimum poll only while the player screen is open.

### P11 🟡 `saveResume` writes 40 full tracks every 4s — **Proposed**

Only `position` changes between writes; the queue changes rarely. Split it —
persist the queue when it changes, the position on the throttle — and each
periodic write becomes a few dozen bytes instead of forty serialised track
objects.

---

## APK size

### P12 🟠 yt-dlp ships ~2,000 extractors to serve SoundCloud — **Proposed**

The single largest size item in the build, and mostly dead weight. YouTube does
not go through yt-dlp at all — `build.gradle` says so, and NewPipeExtractor does
it natively because Android has no JS runtime for the signature challenge. The
only live caller is `soundcloud_downloader.py`.

So the APK carries — and `pyc { src = true }` compiles at build time — the
entire yt-dlp extractor tree for one site. Two ways out:

1. Prune `yt_dlp/extractor/` to `soundcloud`, `common` and `generic` in a
   packaging step. Cheap, reversible, keeps yt-dlp's SoundCloud maintenance.
2. Replace it with a direct SoundCloud v2 client. Smaller still, but now the
   `client_id` rotation is ours to keep up with.

(1) first. It also shortens the first SoundCloud play, which the `pyc` comment
in `build.gradle` already identifies as the worst first-run moment in the app.

### W1 ⚪ `update.apk` in cacheDir — **Fixed**

Deleted before each attempt, never after. A successful update left ~47MB in the
cache indefinitely; a failed one left a truncated file until the next try. Both
paths clean up now.

### W2 ⚪ R8 on a reflection-heavy stack — **still open, carried from D8**

`SPRINT_LOG.md` D8 still applies and nothing here changes it: a release build
must be smoke-tested on a device before tagging, with the equalizer and crossfade
exercised specifically. The keep rules are broad and the failure mode is silence,
not a crash.

---

## Suggested release plan

**v1.2.2 — shipped.** The ten fixes above (S2, S3, S7, P1, P2, P6, P7, P8, P9,
W1). No signing change, so it installs over an existing app in the normal way.
(`v1.2.1` was pushed on `a839945`, the round-9 commit, so that release is a
rebuild of v1.2.0 under a new number and contains none of these.)

**Next release — the cutover.** S1, with the release notes and the in-app notice.
If a library export is wanted ahead of the cutover, v1.2.2 was the release to put
it in — so it now has to ship in a v1.2.3 *before* the cutover, or the cutover
goes out without one.

**The release after.** P3 and P12 — the two biggest remaining numbers, both
needing a device and a stopwatch rather than a review. Then P4/P5, then the
small ones: S4, S5, S6, P10, P11.

## How to confirm the improvements

Numbers here are reasoned from the code, not measured on hardware — there is no
device in this environment, and none of the estimates should go in release notes
unmeasured. Worth capturing on a real low-end phone:

- **Cold start**: `adb shell am start -W` to first frame, before and after, on a
  profile with a well-populated library (P1/P2 scale with stored data, so a
  fresh install will under-report the gain).
- **Idle cost**: `dumpsys batterystats` over an hour with the app resident and
  paused. P6 should be the difference between a constant background load and
  approximately nothing.
- **Memory**: `dumpsys meminfo com.musicplayer` while scrolling a long library.
  P7 should show up in the graphics/bitmap figures.
