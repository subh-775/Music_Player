# Sprint log — RN build vs the WebView reference

Working file for the RN rewrite (`Music_Player`) measured against the WebView
build (`Fix-Spotify`). The WebView build is the **behavioural reference**: where
the two disagree and the WebView was right, the WebView wins.

**Platform note:** this project is **Android-only** — there is no `ios/`
directory and no Xcode project. iOS icon sets / plist entries are therefore not
applicable and were not generated. Say the word if iOS is ever added.

---

## Step 1 — Reference behaviour (WebView), as catalogued

| Area | How the WebView build does it |
|---|---|
| **Audio session / focus** | `BackendService` **deliberately never requests audio focus.** The page drives `navigator.mediaSession`, so Chromium opens the media session and claims focus for the `<audio>` element. Focus is per-*listener*, so a second claim from the service **evicts Chromium's** and Chromium's documented response to `AUDIOFOCUS_LOSS` is to pause — the app was killing its own playback from inside its own process. Letting Chromium own focus also gets correct call/duck/other-app behaviour for free. |
| **Volume** | **Never touched on a normal track transition.** The only code that writes volume is the explicit crossfade, and it always ends by restoring `volumeRef.current`. There is no fade-in on a plain advance. |
| **Track transitions** | `handleEnded` → `playNext()`. Crossfade (when enabled) runs on a second `<audio>` element and swaps at the end. |
| **UI update on track change** | **Synchronous and optimistic**: `playNext`/`startCrossfade` call `setCurrentTrack(normalizeTrack(nextTrack))` from the queue *immediately*, then let the audio catch up. The UI never waits on a player event. |
| **Background / lock screen** | `mediaPlayback` foreground service keeps the process alive; `MediaSessionCompat` + `MediaStyle` notification. Transport listener lives on the **companion object**, not the instance, because `startForegroundService()` is async and `instance` was still null at registration time (the "lock screen works sometimes" bug). Optimistic state flip on hardware transport so the session is never stale. `BECOMING_NOISY` → pause. |
| **Queue state** | `queueRef` mirror + refs everywhere to defeat stale closures; listeners attached once with empty deps. |

---

## Defect list

Ranked. Root causes shared where noted.

### Fixed in Sprint 1

| # | Sev | Defect | Root cause |
|---|---|---|---|
| **D2** | 🔴 Critical | **Volume drops on auto track change and stays low**; doesn't recover while locked/backgrounded; ramps back only after reopening the app. | **JS-timer volume ramps.** Both the crossfade fade-down and `fadeInIfNeeded` ran `setVolume` in `await setTimeout` loops. Android throttles/freezes RN's JS timers once backgrounded → the loop **stalls part way down and stays there**. Reopening thaws the thread and the loop resumes — exactly the reported "gradually ramps back by itself". Made strictly worse in v1.0.2 by a change that made *every* transition start at volume 0. |
| **D3** | 🟠 Major | **Track title lags on swipe** — shows the previous title for a beat. | UI bound to RNTP's `useActiveTrack`, which only updates when the native `PlaybackActiveTrackChanged` event arrives (after the engine transitions + a bridge hop). The reference build has no lag because it sets the track synchronously from the queue on gesture commit. |
| **D5** | 🟡 Minor | Restored (paused) session showed a blank mini player. | Found during self-review of D3: RNTP's hook self-seeds on mount, a hand-rolled store does not. |
| **D6** | 🟡 Minor | App icon looks cropped/"weird" vs Fix-Spotify. | No adaptive icon — only full-bleed square PNGs whose mark covers **83.6%** of the canvas, so every launcher mask crops its edges. Fix-Spotify ships a real adaptive icon (mark on a solid background). |

### Open

| # | Sev | Defect | Notes |
|---|---|---|---|
| ~~D1~~ | ✅ | ~~Queue drag-reorder is gone.~~ | **Fixed in Sprint 2** — see below. |
| ~~D4~~ | ✅ | ~~`RemoteDuck` can resume playback the user deliberately paused.~~ | **Fixed in Sprint 3** — ducking now resumes only what ducking paused. |
| **D7** | 🟡 Minor | Crossfade is now **foreground-only** by design. | Its handoff (seek RNTP to the overlap position, then cut the overlap) is JS work, and JS doesn't run backgrounded — a fade started there would hand off to nobody, leaving overlap + RNTP both audible. Backgrounded transitions now use untouched volume, which is what the reference build did *always*. Revisit only if a fully-native crossfade is wanted. |
| **D8** | ⚪ Watch | R8 shrinking enabled in v1.0.2 is **unverified on device**. | Reflection-heavy stack (RNTP internals, NewPipe/Rhino, Chaquopy). Keep rules are in `proguard-rules.pro`, extended this sprint for the new `setVolume` reflection. A release build must be smoke-tested before tagging. |

---

## Sprint 1 — what changed

**Theme: the native/JS playback boundary. No playback-critical behaviour may
depend on the JS thread running.**

1. **All JS volume ramping deleted.** `fadeInIfNeeded` (a timer ramp) →
   `restoreFullVolume()`, a single idempotent assertion of full volume.
   `playTrack` no longer starts at volume 0.
2. **Volume ramps moved into the native layer.** New
   `AudioModule.fadeOutPlayer(ms)` / `restorePlayerVolume()` drive ExoPlayer's
   volume from a **`Handler` on the main looper**, which keeps ticking with the
   screen off (the process is alive — RNTP holds a `mediaPlayback` foreground
   service). Reached via `PlaybackSession.exoPlayer()`, extracted from the
   existing session-id reflection.
3. **Every native ramp is self-restoring.** On reaching the floor it schedules a
   hard reset to 1.0 (`durationMs + 1500ms`). A frozen JS thread, a dead bridge,
   or a crossfade whose handoff never arrives **cannot** leave the player quiet.
   `onCatalystInstanceDestroy` also restores.
4. **Crossfade gated to the foreground** (`AppState.currentState === 'active'`) —
   see D7.
5. **Optimistic now-playing store** (D3): a mirror of the engine queue + index,
   kept warm by the track-change event, so `skipNext`/`skipPrevious`/`playTrack`
   publish the committed track with **no await**. The native event reconciles
   afterwards. `useActiveTrack` is now ours, not RNTP's; all seven consumers
   import from `../player` so they all get it. Failed skips roll the optimistic
   value back.
6. **Icon** (D6): full adaptive set generated from `rework.png` — foreground at
   exactly **66% coverage** (the guaranteed-visible safe zone), `#121212`
   background, `monochrome` layer for Android 13+ themed icons, legacy
   square + round PNGs for pre-API-26, all five densities. Splash mark
   regenerated. Stale artwork overwritten.
7. **R8 keep rules** extended for the new `setVolume`/`getVolume` reflection —
   without them the fades would silently no-op in release builds only.

### Decisions rejected
- *Native ExoPlayer fade for background crossfade* — the **ramp** is native now,
  but the **handoff** is still JS, so a background crossfade would desync. Gating
  to foreground is honest; a fully-native crossfade is a bigger piece of work
  with little payoff (crossfade defaults to off).
- *Keeping a short fade-in to soften the Bluetooth start-of-track blip* — that
  was the v1.0.2 change that caused D2. Never trade a guaranteed silence bug for
  a cosmetic one.
- *An `AppState` "restore volume on foreground" listener* — would only fix it
  once you look at the phone. The native fail-safe fixes it where it breaks.

---

## Sprint 2 — D1: queue drag-reorder restored

**Root cause of the original lag/overlap:** the old implementation called
`setDragOver(...)` on **every pan frame**, so each finger movement re-rendered
the entire list to recompute which rows should slide. Row `React.memo` didn't
help — the `shift` prop genuinely changed for many rows at once. The overlapping
rows came from the same place: React repainting rows mid-gesture underneath a
floating dragged row.

**Fix — no per-frame React work at all:**
- One `Animated.Value` follows the finger (`setValue`, never `setState`).
- Every other row's offset is an **interpolation** of that value: a step
  function with a ±14px transition band, so rows slide out of the way as the
  dragged item crosses their midpoint. React renders **twice per gesture** —
  once on drag start, once on drop.
- Responders are cached per index in a `Map`, so the re-render on drag start
  can't hand the live gesture a new responder object (the old "snapped back"
  bug).

**Correctness improvements over the original:**
- **Only upcoming tracks are draggable.** The playing track is pinned under a
  "Now playing" header and nothing can be dropped above it. RNTP's `remove()`
  maps to ExoPlayer's `removeMediaItem`, so a reorder able to touch the active
  row could **stop playback mid-drag**. Also matches the reference build, whose
  `queue` is upcoming-only. `moveQueueItem()` re-checks this server-side.
- Queue mutation moved out of the screen into `player.ts` (`moveQueueItem`),
  next to the rest of the queue logic, and it refreshes the engine mirror so the
  optimistic now-playing store stays consistent after a reorder.
- Append vs insert: after `remove(from)` the queue is one shorter, so a drop
  into the last slot must `add([item])` (append), not `add([item], to)` —
  inserting "before" a non-existent index.
- The **"Recommended for you" divider was removed from the list** and became a
  per-row label. A section header made rows non-uniform in height, which would
  have put every drop below it one slot out (`dy / ROW_H` and the step midpoints
  both assume a constant row height). Caught in self-review, not on device.

**Deferred:** auto-scroll when dragging to the top/bottom edge of a long queue.
Reordering within a screenful works; dragging a track across a 50-item queue
still needs manual scrolling between drags.

---

## Sprint 3 — D4 + queue auto-scroll

**D4: ducking could resume a pause the user made.** `RemoteDuck` called
`play()` on any `paused === false`, regardless of who paused or why — and audio
focus is lost/regained constantly (chime, navigation prompt, call ending). The
reference build never had this because Chromium owned focus and only resumed the
element it had paused itself.
- Ducking now records whether **it** caused the pause, and resumes only then. A
  transient loss is only claimed as ours if we were actually playing.
- A **permanent** focus loss never auto-resumes.
- Any explicit transport — remote play/pause/stop, or the in-app play/pause —
  clears the flag; the user's intent outranks what ducking remembered. Flag
  lives in `duckState.ts` because both the service and the player need it and
  importing either from the other would be a cycle.

**Queue auto-scroll** (deferred from Sprint 2): dragging into the top/bottom
72px scrolls the list. The drop index is computed from the row's total travel
*through the list* (finger delta **+** content scrolled under it) — using the
finger delta alone would make the row drift away from the finger and land every
post-scroll drop short by the scrolled amount. The list is wrapped in a View
that measures itself, since `measureInWindow` is on `View`, not `ScrollView`.

---

## Remaining

Nothing left in code. One item needs **your device/CI**:

- **D8 — the R8 (minify + resource-shrink) release build is still unverified.**
  There is no Android SDK or JDK in the dev environment here, so `assembleRelease`
  cannot be run locally; CI is the only place it can be proven. Keep rules cover
  RNTP internals, NewPipe/Rhino, Chaquopy, `com.musicplayer.**`, and the
  ExoPlayer `setVolume`/`getVolume` reflection added in Sprint 1. **Run a
  `workflow_dispatch` → `release` build and confirm it boots, plays, and resolves
  YouTube before tagging.** If anything breaks there, the fix is a keep rule, not
  a revert.
