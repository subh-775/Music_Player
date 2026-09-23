# Round 11 — "it should feel instant on bad data"

**Product requirements + audit, for the release after `v1.2.2`.**
Audit of `mobile` at `1bee6ee`: the React Native app, the embedded Python/Flask
backend, the Kotlin native modules and the Android build.

Rounds 1–10 fixed **behaviour**. Round 10 (`AUDIT.md`) costed **idle and cold
start**. This round is about the **network**: what the app spends on a slow
connection, and what the user sees while it spends it. Plus seven specific
reports from the field.

---

## 0. What this app is

React Native 0.75.4, Hermes, old architecture, Android-only (`arm64-v8a`).
64 TS/TSX modules, ~18k lines. Navigation is hand-rolled — no React Navigation;
`App.tsx` holds the tab state and every overlay is a `<View>` at a `zIndex`,
never a `<Modal>` (a Modal is its own Android window and would cover the mini
player). Gestures are `react-native-gesture-handler` + `react-native-reanimated`
shared values, so drags run on the UI thread.

The unusual part: **the backend ships inside the APK.** Chaquopy embeds CPython
and a Werkzeug server on `127.0.0.1:8770`; all catalogue, search, lyrics and
audio streaming goes through it. Audio is `react-native-track-player`
(ExoPlayer). So "slow network" here means three separate hops — RN → local
Flask → JioSaavn/SoundCloud/YouTube — and artwork does **not** go through the
local server at all; `<Image>` fetches remote CDNs directly.

| Severity | Count | Shipped in `v1.2.3` | Not doing |
|---|---|---|---|
| 🟠 Major | 5 | N1, N2, B1, U4, F1 | — |
| 🟡 Minor | 6 | U1, U2, U3, F2 | N3, N4 |
| **Total** | **11** | **9** | **2** |

Everything marked shipped is verified: `tsc` clean, **51 tests pass** (three new
suites, 14 new cases), `eslint src/ App.tsx __tests__/` at **0 errors** and two
pre-existing warnings, docs site builds.

---

## 1. Network — the reported symptom

> *"on low and slow data connection, the application takes a bit time to load
> artwork, or play songs"*

### N1 🟠 Every cover is downloaded **twice**, and the second copy is uncached

`AudioModule.kt:418 artworkColor()` opens a raw
`java.net.URL(url).openConnection()` and reads the **whole** image to hand it to
androidx `Palette` — the same 500×500 JPEG `<Image>` is fetching through Fresco
at that moment, on the same starved link. There is no HTTP cache installed, so
it re-downloads on every track change and again on every launch.

Both the mini player and the full player call `useArtworkColor`, and the tint is
purely decorative — it is competing for bandwidth with the audio stream that is
trying to start.

**Fix.** Two lines and a one-liner:

1. Ask Palette for `thumbArtwork(url)` — the 150×150. Palette samples the bitmap
   down to ~112px anyway (`AudioModule.kt:432`), so the extra pixels were being
   thrown away, and the 150 URL is **the one the list row already downloaded**.
2. `HttpResponseCache.install()` in `MainApplication.onCreate` — Android's own
   transparent cache for `HttpURLConnection`. 10 MB on disk. Native platform
   feature, no dependency.

**Effect.** ~60 KB → ~8 KB per new track, and **zero** on a repeat or a relaunch.

### N2 🟠 A library row downloads four full-size covers to draw four 28px squares

`AUDIT.md P7` fixed this for `TrackRow` and `DownloadRow` by adding
`thumbArtwork`. `CollectionArt.tsx` was missed, and it is the worst offender in
the app: the 2×2 mosaic maps `getBestArtworkUrl` over the first four tracks —
**four 500×500 images per row**, each drawn at 28dp. A library with 12 playlists
pulls 48 of them on the Library tab.

**Fix.** `thumbArtwork` on the mosaic and the single-cover path. ~90% fewer bytes
for the same pixels.

### N3 🟡 `warmArtwork` prefetches only the player-size cover — **not doing**

`player.ts:832` prefetches ±2 tracks' artwork so a swipe lands on a decoded
image. Correct, and it stays. The thought was to warm the *thumb* URL too, for
the queue sheet and the track rows — until it turned out those rows already
fetch their own covers when the list virtualiser mounts them, well before a
track change is relevant. The extra prefetch would have spent data to save
nothing. **Cut.**

### N4 🟡 Fresco's disk cache is left at its 40 MB default — **Proposed**

RN's `FrescoModule` initialises the image pipeline itself and guards on a
private static, so a custom `ImagePipelineConfig` from `MainApplication` gets
silently overwritten. Raising the cache means replacing the autolinked module —
real risk for a modest win now that N1+N2 have cut the bytes ~85%. **Not doing
it.** Revisit if artwork still misses after a week of use.

---

## 2. Playback start

### B1 🟠 The engine-stopped warning fires during a healthy cold start

> *"sometimes when i open app it says: music engine is stopped try again, idk
> why but it works but still shows this notification on startup"*

**Root cause, and it is not the backend.** `backend.ts:47 warnIfEngineStopped()`
runs after any failed `apiGet`, probes `/health` **once**, and calls one
unanswered probe death. During cold start Chaquopy is still extracting the
stdlib and importing Flask, and Werkzeug is serving several concurrent warm-up
requests on a phone-grade CPU — a single probe timing out there is routine. The
app then tells the user it is broken while it is merely starting, which is
exactly backwards.

**Fixed.** The module already has the right tool: `waitForBackend(ms)`, which
polls with backoff and is used everywhere else at boot. Replace the single probe
with `waitForBackend(4000)`. A backend that is booting or busy answers inside
four seconds; one that has actually been killed never does. One line, and it
fixes every caller, not just the boot path.

*Verified by a test (`__tests__/engineWarning.test.ts`): a `/health` that fails once
then succeeds must produce no toast.*

### Already good — checked, not changing

Stream resolution is warmed in parallel with the RNTP bridge calls
(`warmStream`), the next track is pre-resolved at 3s (`prefetchNext`), only the
tapped track crosses the bridge before `play()`, the JioSaavn bitrate ladder is
pinned per track after the first success, and the Werkzeug server is threaded.
The play path is not where the remaining latency is.

---

## 3. Interface

### U1 🟡 The liked "+" has a black rim the rest of the app does not

> *"the like button when + is clicked over a song doesn't matches like other
> buttons, remove those black border from around the green tick"*

Lucide draws `CircleCheck` as a circle plus a tick and applies `color` as the
stroke to **both**. `AddButton.tsx` sets `fill={C.accent}` with `color={C.bg}`,
so the green disc gets a true-black rim. The unliked state next to it is
`CirclePlus` — an outline glyph at `strokeWidth 1.8`, no fill, no rim.

**Fix.** Liked becomes the same outline glyph in accent green: `CircleCheck`,
`color={C.accent}`, no fill. Both states are now one shape at one weight; only
the colour and the glyph change, which is what "matches the other buttons"
means.

### U2 🟡 Confirmation toasts for removals

> *"remove some popups such as: removed from liked songs or any playlist"*

Dropped: `Removed from {playlist}`, `Removed from Liked Songs`, `Removed from
playlist`. The row disappears — that is the confirmation.

**Kept on purpose:** `Removed from downloads` / `Removed (the file was already
gone)`. That one deletes a file off disk, and the second wording is the only
place the user learns the file had vanished behind the app's back. *Say so if
you want it gone too.*

### U3 🟡 "Press back again to exit" is the only green-bordered surface in the app

> *"it has green border with black inner region"*

`Toaster.tsx` styles the `warn` kind as a `#161616` pill with a `1px #1db954`
border — a treatment that appears nowhere else. Every other floating surface
(the mini player, sheets) is `rgba(38,38,38,0.9)` with a white hairline and
elevation.

**Fix.** Same pill shape and centred width — it still has to read differently
from a song confirmation — but the app's own floating-surface finish instead of
the green outline.

### U4 🟠 Unpinned library rows never move

> *"apart from pinned playlists, the rest in which songs keep added should come
> over each other after the pinned ones"*

`sortPinned` returns `0` for two unpinned rows, so they keep their store order:
saved collections in save order, then playlists in creation order. Adding a song
to a playlist does not move it.

**Fix.** An `updatedAt` stamp on `Playlist` and on saved collections, touched by
every add / remove / rename / re-cover, and unpinned rows sorted newest-first
after the pins. Rows created before this release have no stamp and fall back to
`createdAt`, so an existing library does not scramble on upgrade.

*Verified by a test (`__tests__/pins.test.ts`): pins stay in pin order, the rest
sort by recency, and a missing stamp sorts last rather than first.*

---

## 4. The morph

### F1 🟠 Mini player ↔ full player is a slide, not a transition

> *"when mini-player is slide above it will smoothly open the big music panel
> with the small artwork slowly taking the big place... when the main big song
> player is slid from top to bottom it will convert into mini-player — the
> artwork will shrink smoothly as per finger position control"*

Today: the full player is a full-screen sheet translated by a `sheetY` shared
value. Dragging its header down slides the whole thing off the bottom; the mini
player is simply revealed behind it. The two artworks are unrelated views that
happen to show the same image.

**What ships.** A shared-element morph, driven by the same `sheetY`, on the UI
thread, tracking the finger in both directions:

- `sheetY` moves out of `PlayerScreen` into `src/playerSheet.ts`, the same
  pattern `src/drawer.ts` already uses for the navigation panel — so a gesture
  anywhere can drive it frame by frame instead of asking a component to animate
  itself after the fact.
- Both artworks report their on-screen rect (`measureInWindow`) into that
  module. Nothing is hardcoded, so it survives rotation and a relayout.
- The sheet's own downward travel does all the vertical work. The artwork only
  scales (`1 → 54/(W−24)`), slides horizontally to the mini slot, and rounds its
  corners `10 → 6`. Once it reaches the mini position it **parks** while the
  rest of the sheet keeps going.
- Sheet background and chrome (header, meta, transport) fade out over the same
  progress, so at the end the only thing on screen is an artwork sitting exactly
  on top of the real mini player's artwork — identical image, identical rect.
  Unmounting is then invisible.
- **Opening runs the same maths backwards for free.** Dragging up on the mini
  player now drives `sheetY` directly: the cover grows out of the mini slot
  under the finger, and letting go short of the threshold puts it back.

Two things fell out of building it that were not in the plan, and both were
about where the motion is actually *visible*:

- **The pull starts at the span, not at the sheet's closed position.** The sheet
  is parked a full screen height down; the distance over which the cover changes
  size is shorter than that. Driving the drag from the closed position meant the
  first ~40% of an upward pull moved the panel while changing nothing anyone
  could see — the gesture felt dead until it suddenly committed. The same
  correction applies to opening by tap, which now spends its whole 260ms on the
  part you can watch.
- **The guard for "nothing measured yet" belongs in the geometry, not at the one
  call site that had it.** A test caught this: with an unmeasured rect the
  transform was still shrinking the cover toward a square whose size it did not
  know. It now returns the identity, and the panel degrades to the old plain
  slide rather than to something wrong.

No new dependency. No `react-native-shared-element`.

*Verified by a test (`__tests__/playerMorph.test.ts`): at the end of the travel
the transformed cover occupies the mini player's rect exactly — same x, same y,
same size, and a corner radius that reads as 6px on screen after the scale.*

### F2 🟡 The mini player fetches the player-size cover for a 54dp square

Normally this would be N2 again. It is **deliberate and now load-bearing**:
sharing one URL with the full player is what makes the morph swap decoded
bitmaps instead of fetching. Documented in place so a later tidy-up does not
"fix" it.

---

## 5. Out of scope, still open

Carried from `AUDIT.md`, unchanged: **S1** (every release is still signed with
the public Android debug key — a one-way door that needs a release plan, not a
patch), S4, S5, S6, P3, P4, P5, P10, P11, P12, W2.

## 6. Verification

`npx tsc --noEmit` · `npx jest` · `npx eslint src/ App.tsx __tests__/`. No
Python changed this round, so no `py_compile`. Three new suites cover the logic
that could break silently:

| Suite | Pins |
|---|---|
| `engineWarning.test.ts` | a `/health` that fails once then answers must produce **no** toast; one that never answers must produce one |
| `libraryOrder.test.ts` | pins keep pin order; the rest sort by recency; a missing stamp sorts **last**, so an upgraded library does not scramble |
| `playerMorph.test.ts` | the cover lands exactly on the mini slot; parks past the end; degrades to the identity unmeasured |

Bytes and timings above are reasoned from the code. Worth confirming on a real
phone with the radio throttled:

- **Artwork on a cold library**: a proxy or `adb shell dumpsys netstats`,
  Library tab, fresh install. N1+N2 should be most of the traffic.
- **The morph**: 60fps under `adb shell dumpsys gfxinfo com.musicplayer
  framestats` while dragging — it runs on the UI thread, so a dropped frame here
  means a layout is being forced, not that JS is busy.
