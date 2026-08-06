/**
 * Audio playback, on ExoPlayer via react-native-track-player.
 *
 * Why a native engine rather than something JS-side: it plays in a real
 * foreground service, so audio survives the app being backgrounded, and it
 * publishes a MediaSession — which is what makes lock-screen controls and
 * Bluetooth/earbud buttons work properly. That was the whole reason for moving
 * off the WebView.
 *
 * IMPORTANT: the native side only exists in a build that included this library.
 * On an older APK the JS module still bundles but every native call throws, so
 * everything here is guarded and `isAvailable()` reports the truth instead of
 * the app crashing.
 */
import {useEffect, useState, useSyncExternalStore} from 'react';
import {AppState} from 'react-native';
import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  Event,
  RepeatMode,
  State,
  usePlaybackState,
  type Track as RNTPTrack,
} from 'react-native-track-player';
import {apiUrl, getRadio, getStreamInfo, type Track} from './backend';
import {currentQuality, readSettings} from './store';
import {cleanText, getTrackId, isPlayableTrack, normalizeTrack} from './tracks';
import {
  applyAudioEffects,
  beginCrossfade,
  crossfadePosition,
  crossfadeSupported,
  endCrossfade,
  fadeOutPlayer,
  restorePlayerVolume,
} from './audioEffects';
import {setPausedByDuck} from './duckState';
import {sleepTimerOnTrackChange} from './sleepTimer';
import {remember} from './recentlyPlayed';
import {clearResume, readResume, saveResume} from './resume';

let ready = false;
let available: boolean | null = null;

/**
 * The backend Tracks behind whatever is currently queued.
 *
 * The engine's own queue items are a reduced shape — url, title, artist,
 * artwork — with no `sources`, no ISRC and no artwork_urls. The player screen
 * needs the real thing to show a source badge, resolve a download, or match a
 * like, so the originals are kept alongside and looked up by title+artist.
 */
let queueSource: Track[] = [];

// How many tracks the user has queued (via "add to queue") since the current
// song started. Add-to-queue inserts right after the current track and after
// each other, so several adds keep their order and all play SOON — not at the
// bottom of a long album/playlist. Reset whenever the active track changes.
let queuedAhead = 0;

/** The full Track behind an engine queue item, or null if it isn't ours. */
export function sourceTrackFor(
  active: {title?: string | null; artist?: string | null} | null | undefined,
): Track | null {
  if (!active) {
    return null;
  }
  const title = String(active.title ?? '').toLowerCase();
  const artist = String(active.artist ?? '').toLowerCase();
  return (
    queueSource.find(
      t =>
        (t.title || '').toLowerCase() === title &&
        (t.artist || '').toLowerCase() === artist,
    ) ?? null
  );
}

/** Build the streaming URL. proxy_stream handles range requests + the bitrate
 *  ladder, and apiUrl attaches the API token the backend requires. */
export function streamUrlFor(
  track: Track,
  bitrate = currentQuality(),
): string | null {
  // A downloaded track has no `sources` at all — it was scanned off disk — so
  // it is served straight from the file. Without this branch, playing anything
  // from the Downloads folder failed with "no playable source", which is
  // exactly backwards: it is the one track guaranteed to be available.
  if (track.file_path) {
    return apiUrl(`/local?path=${encodeURIComponent(track.file_path)}`);
  }
  const source = track.playable_source || track.primary_source || '';
  const url = source ? track.sources?.[source]?.url : undefined;
  if (!url) {
    return null;
  }
  return apiUrl(
    `/proxy_stream?url=${encodeURIComponent(url)}&source=${encodeURIComponent(
      source,
    )}&bitrate=${bitrate}`,
  );
}

/** One-time engine setup. Returns false when the native module isn't in this build. */
export async function setupPlayer(): Promise<boolean> {
  if (ready) {
    return true;
  }
  if (available === false) {
    return false;
  }
  try {
    await TrackPlayer.setupPlayer({
      // Android handles audio focus for us: a call or another app ducks/pauses
      // us and we resume after. Doing this natively is what keeps Bluetooth
      // hand-offs in sync instead of the app and the headset disagreeing.
      autoHandleInterruptions: true,
      // RNTP's defaults (minBuffer 50s, playBuffer 2.5s) are ExoPlayer's OWN
      // defaults — tuned for VIDEO, where a deep buffer hides network jitter.
      // Nobody had ever set these for an audio-only player, so every play AND
      // every seek was gated on 2.5 real seconds of rebuffering before sound
      // resumed — through a proxy that has to resolve + reconnect to the CDN
      // first. That is the actual "why does this feel like it's struggling"
      // the WebView build never had this knob wrong to begin with.
      // 320kbps audio is tiny: 15s of lookahead is ~600KB, not worth hoarding
      // 50s for. playBuffer down to 400ms is still enough margin to not
      // audibly stutter on a normal connection.
      minBuffer: 15,
      maxBuffer: 30,
      playBuffer: 0.4,
      // Seeking BACKWARD (double-tap peek, tapping an earlier lyric line)
      // reuses audio already downloaded instead of a fresh network round trip
      // through the proxy — was 0 (nothing kept), so even a 2-second rewind
      // paid the full resolve+reconnect cost again.
      backBuffer: 20,
    });
    await TrackPlayer.updateOptions({
      android: {
        // Swiping the app away STOPS playback and clears the notification.
        // ContinuePlayback left an orphan notification behind when Android
        // killed the process, with no way to dismiss it. Backgrounding the app
        // (the normal case) still keeps playing — only an explicit swipe-away
        // stops it, which is what people actually expect that gesture to mean.
        appKilledPlaybackBehavior:
          AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
      },
      capabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.SkipToNext,
        Capability.SkipToPrevious,
        Capability.SeekTo,
        Capability.Stop,
      ],
      // What the lock screen / notification actually shows.
      compactCapabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.SkipToNext,
      ],
      notificationCapabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.SkipToNext,
        Capability.SkipToPrevious,
        // Declared here too, not just in `capabilities` — this list is what
        // the MediaSession advertises to the notification/lock screen, and
        // without SeekTo there the lock-screen progress bar renders but
        // refuses to drag.
        Capability.SeekTo,
      ],
      progressUpdateEventInterval: 1,
    });
    await TrackPlayer.setRepeatMode(RepeatMode.Off);

    // Every track the engine lands on — auto-advance, radio, a queue tap —
    // goes into Recently Played AS IT STARTS, so Home updates live. Manual
    // playTrack() also records (first write wins on order; remember() de-dupes).
    TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, async e => {
      // The "play this soon" window is relative to the current song — a new song
      // starts a fresh one, so anything queued now goes right after it again.
      queuedAhead = 0;
      // The engine is authoritative — reconcile the optimistic mirror with what
      // actually started, and keep the queue snapshot warm for the next gesture.
      publishTrack(e.track ?? null);
      // A native event, so the sleep timer's deadline is honoured even when the
      // screen has been off long enough for JS timers to be throttled.
      sleepTimerOnTrackChange();
      const src = sourceTrackFor(e.track ?? null);
      if (src) {
        remember(src);
      }
      // Save the session on every track change (forced past the throttle), so a
      // reopen lands on the right song even if the app was killed mid-track.
      try {
        const idx = (await TrackPlayer.getActiveTrackIndex()) ?? 0;
        await refreshEngineMirror(idx);
        saveResume(
          {track: src, position: 0, queue: queueSource, index: idx},
          true,
        );
      } catch {}
      // Crossfade's other half. With a real overlap running, hand off to the
      // incoming track (seek RNTP to where the overlap reached, then cut it).
      // Otherwise bring the incoming one up from quiet, or just ensure full
      // volume on a normal advance / manual skip.
      if (cfActive) {
        await handoffCrossfade();
      } else {
        // Defensive: if an overlap player somehow survived (a fade that never
        // handed off), silence it NOW so it can't keep playing a second,
        // "wrong" song over the top of the queue's real next track.
        endCrossfade();
        restoreFullVolume();
      }
      // Effects die with the audio session; re-attach for the new one.
      applyAudioEffects();
    });

    ready = true;
    available = true;
    // If the engine came back with a queue already loaded (the service outlived
    // the JS context), adopt it now rather than showing nothing until the next
    // track change.
    refreshEngineMirror()
      .then(() => publishTrack(engineQueue[activeIndex] ?? null))
      .catch(() => {});
    return true;
  } catch {
    // Old APK without the native engine, or the player is already initialised.
    if (ready) {
      return true;
    }
    available = false;
    return false;
  }
}

/** True once the engine has initialised; null until setup has been attempted. */
export function engineAvailable(): boolean | null {
  return available;
}

/**
 * Restore the last session: the same song, at the timestamp you left it,
 * PAUSED, with the queue intact. Returns true if something was restored, which
 * is what tells the shell to show the mini player straight away.
 *
 * Deliberately does not call play() — reopening the app and having music
 * suddenly start is startling; the WebView paused too. A tap on play resumes.
 */
export async function restoreSession(): Promise<boolean> {
  if (!(await setupPlayer())) {
    return false;
  }
  const s = await readResume();
  if (!s?.queue?.length) {
    return false;
  }
  const items = s.queue
    .map(t => ({t, q: toQueueItem(t, currentQuality())}))
    .filter(x => x.q !== null);
  if (!items.length) {
    return false;
  }
  try {
    queueSource = items.map(x => x.t);
    const idx = Math.max(0, Math.min(items.length - 1, s.index));

    await TrackPlayer.reset();
    // Add the track you LEFT ON first (index 0) and seek it, so the mini player
    // shows the right song at the right timestamp the instant the engine is up —
    // instead of waiting for the whole queue to rebuild and skip into place.
    await TrackPlayer.add([
      items[idx].q!,
      ...items.slice(idx + 1).map(x => x.q!),
    ]);
    if (s.position > 0) {
      await TrackPlayer.seekTo(s.position);
    }
    applyAudioEffects();
    // The earlier tracks come back afterward, prepended so Previous still works;
    // this shifts the active index to idx without ever showing track 0.
    if (idx > 0) {
      await TrackPlayer.add(
        items.slice(0, idx).map(x => x.q!),
        0,
      );
    }
    // Seed the now-playing mirror. A restored session is left PAUSED, so no
    // track-change event fires — without this the mini player would sit blank
    // until the user pressed play (RNTP's own hook self-seeded on mount; ours
    // has to be told).
    await refreshEngineMirror();
    publishTrack(engineQueue[activeIndex] ?? null);
    // Left paused — see above.
    return true;
  } catch {
    return false;
  }
}

/** Shape a backend Track for the audio engine. Returns null if unplayable. */
/**
 * Fire the SAME resolve `/proxy_stream` will need, right now, in parallel with
 * whatever else is happening — never awaited.
 *
 * This is the other half of the buffer tuning above: shrinking playBuffer only
 * helps once the stream is already resolved. Without this, that resolve (a
 * real network round trip to JioSaavn/SoundCloud/YouTube) only ever started
 * the moment ExoPlayer's own HTTP request reached the backend — AFTER
 * TrackPlayer.play() had already been awaited, fully serial with everything
 * else a tap does. Firing it here overlaps it with the RNTP bridge calls
 * instead, so by the time ExoPlayer actually asks, the answer is often
 * already cached.
 */
function warmStream(track: Track | null | undefined, bitrate: number): void {
  if (!track || track.file_path) {
    return; // downloaded file — nothing to resolve
  }
  getStreamInfo(track, bitrate).catch(() => {});
}

function toQueueItem(track: Track, bitrate: number) {
  const url = streamUrlFor(track, bitrate);
  if (!url) {
    return null;
  }
  return {
    id: `${track.title}-${track.artist}`,
    url,
    title: track.title,
    artist: track.artist,
    artwork: track.artwork_url,
    duration: track.duration_ms ? track.duration_ms / 1000 : undefined,
  };
}

async function requireEngine(): Promise<void> {
  if (!(await setupPlayer())) {
    throw new Error(
      'The audio engine is missing from this build — install the newest APK.',
    );
  }
}

/**
 * Play `track`, queueing the list it came from so next/previous work.
 *
 * Everything playable in `context` is queued (not just the one track), because
 * a music app where "next" does nothing is the thing that feels broken. Tracks
 * with no resolvable source are dropped rather than left as dead queue entries.
 */
export async function playTrack(
  track: Track,
  context?: Track[],
  bitrate = currentQuality(),
): Promise<void> {
  await requireEngine();

  const list = context?.length ? context : [track];
  const items = list
    .map(t => ({t, q: toQueueItem(t, bitrate)}))
    .filter((x): x is {t: Track; q: NonNullable<typeof x.q>} => x.q !== null);

  if (!items.length) {
    throw new Error('This track has no playable source.');
  }

  // Find where the tapped track landed after unplayables were dropped.
  let startAt = items.findIndex(
    x => x.t.title === track.title && x.t.artist === track.artist,
  );
  if (startAt < 0) {
    startAt = 0;
  }

  queueSource = items.map(x => x.t);

  // Start resolving the tapped track's stream NOW — see warmStream — instead
  // of only after the RNTP calls below have all been awaited.
  warmStream(items[startAt].t, bitrate);

  cancelCrossfade(); // and guarantee full volume for the fresh track
  // A brand-new queue is in the order the user picked — shuffle no longer
  // describes anything, so the icon must go back to off.
  preShuffleUpcoming = null;
  setShuffleFlag(false);
  await TrackPlayer.reset();
  // Add the CHOSEN track (and everything after it) FIRST, so the engine's
  // active track is the one you tapped from the very first frame. Adding the
  // whole list and then skip(startAt) briefly made the mini player show track 0
  // — its artwork, title and slide — before jumping to your song.
  await TrackPlayer.add(items.slice(startAt).map(x => x.q));
  if (startAt > 0) {
    // Prepend the earlier tracks so Previous still works. Inserting before
    // index 0 shifts the active track to startAt without ever surfacing track 0.
    await TrackPlayer.add(
      items.slice(0, startAt).map(x => x.q),
      0,
    );
  }
  // Full volume, always. Starting silent and ramping up in JS (a previous
  // attempt at softening a Bluetooth start-of-track blip) is what left tracks
  // stuck quiet whenever the ramp was interrupted — never trade a guaranteed
  // silence bug for a cosmetic one. Play only once the queue is FULLY built —
  // starting mid-rebuild left a brief window where a swipe (next/previous)
  // acted on a half-formed queue and could land on the wrong song.
  await TrackPlayer.setVolume(1);
  // Publish the tapped track immediately — the queue is built, so this IS what
  // is about to sound; waiting for the engine event showed the old song's title
  // for a beat. Also seeds the mirror so an instant swipe skips from the right
  // place rather than from a stale index.
  engineQueue = items.map(x => x.q as RNTPTrack);
  activeIndex = startAt;
  publishTrack(engineQueue[startAt] ?? null);
  await TrackPlayer.play();

  // Recorded at play-START, before enrichment runs. remember() replaces an
  // existing entry rather than appending, so the cleaned-up version wins later.
  remember(items[startAt].t);

  // Android destroys audio effects along with the audio session, so the EQ has
  // to be re-attached each time playback starts — otherwise the setting works
  // for exactly one song and then silently stops.
  applyAudioEffects();
}

/**
 * Queue a track to play after everything already lined up.
 *
 * Also records it in queueSource so the player screen can still resolve its
 * badges and download when it comes around — without this, a song added to the
 * queue loses its sources the moment it starts playing.
 */
export async function addToQueue(track: Track): Promise<void> {
  await requireEngine();
  const item = toQueueItem(track, currentQuality());
  if (!item) {
    throw new Error('This track has no playable source.');
  }
  // "Add to queue" means "play this soon", not "after 40 songs you didn't
  // pick". Insert right after the current track (and after anything else queued
  // since it started), so it jumps ahead of the rest of the album/playlist —
  // the way Spotify's queue works. Positions come from the ENGINE queue (the
  // truth); the JS pool can drift after a manual reorder.
  const queue = await TrackPlayer.getQueue();
  const idx = (await TrackPlayer.getActiveTrackIndex()) ?? -1;
  const at =
    idx >= 0 ? Math.min(idx + 1 + queuedAhead, queue.length) : queue.length;
  if (at < queue.length) {
    await TrackPlayer.add([item], at);
  } else {
    await TrackPlayer.add([item]);
  }
  queuedAhead++;
  queueSource = [...queueSource, track];
}

/**
 * Move a queued track. Both indices are ENGINE indices.
 *
 * Only tracks AFTER the active one can move. RNTP maps remove() onto
 * ExoPlayer's removeMediaItem, and removing the item that is currently playing
 * tears down playback — so a reorder that could touch the active row would stop
 * the music mid-drag. The queue UI only offers the upcoming tracks for exactly
 * this reason; this guard is the backstop.
 */
export async function moveQueueItem(
  from: number,
  to: number,
): Promise<boolean> {
  if (from === to) {
    return true;
  }
  try {
    const activeIdx = await TrackPlayer.getActiveTrackIndex();
    if (activeIdx == null || from <= activeIdx || to <= activeIdx) {
      return false;
    }
    const q = await TrackPlayer.getQueue();
    const item = q[from];
    if (!item) {
      return false;
    }
    await TrackPlayer.remove([from]);
    // `to` indexes the queue as it is AFTER the removal (length n-1), which is
    // the same convention as splice. The last slot has no element to insert
    // before, so it has to be an append rather than an insert.
    if (to >= q.length - 1) {
      await TrackPlayer.add([item]);
    } else {
      await TrackPlayer.add([item], to);
    }
    await refreshEngineMirror();
    return true;
  } catch {
    return false;
  }
}

/**
 * Optimistic now-playing.
 *
 * RNTP's own useActiveTrack only updates when the native
 * PlaybackActiveTrackChanged event arrives — which is AFTER ExoPlayer has
 * actually transitioned and after a bridge hop. Binding the UI straight to it
 * is why swiping to the next song showed the PREVIOUS title for a beat.
 *
 * The reference build has no such lag because it sets the current track
 * synchronously from the queue the moment the gesture commits
 * (`setCurrentTrack(nextTrack)` in playNext) and lets the audio catch up. Same
 * thing here: a mirror of the engine queue, kept warm by the track-change
 * event, so a skip can publish the committed track with no await at all. The
 * native event still lands afterwards and reconciles — it can only ever agree.
 */
let engineQueue: RNTPTrack[] = [];
let activeIndex = 0;
let trackSnapshot: RNTPTrack | null = null;
const trackListeners = new Set<() => void>();

function publishTrack(t: RNTPTrack | null): void {
  trackSnapshot = t;
  trackListeners.forEach(l => l());
}

/** Re-read the engine's queue and index so the mirror is warm before a gesture. */
async function refreshEngineMirror(index?: number): Promise<void> {
  try {
    engineQueue = await TrackPlayer.getQueue();
    activeIndex = index ?? (await TrackPlayer.getActiveTrackIndex()) ?? 0;
  } catch {
    /* engine not up — the next event refreshes it */
  }
}

/** Move the mirror by one and publish immediately. Returns false at the ends. */
function publishStep(delta: 1 | -1): boolean {
  const next = engineQueue[activeIndex + delta];
  if (!next) {
    return false;
  }
  activeIndex += delta;
  publishTrack(next);
  return true;
}

/** The track one step away in the mirror, without moving anywhere — what the
 *  swipe-to-change-song gesture previews while the finger is still down. */
export function peekAdjacentTrack(delta: 1 | -1): RNTPTrack | null {
  return engineQueue[activeIndex + delta] ?? null;
}

/** The track the UI should show: optimistic on gesture, reconciled by the
 *  engine event. Drop-in replacement for RNTP's useActiveTrack. */
export function useActiveTrack(): RNTPTrack | null {
  return useSyncExternalStore(
    l => {
      trackListeners.add(l);
      return () => trackListeners.delete(l);
    },
    () => trackSnapshot,
  );
}

/** Skips always resume playback: changing song while paused and getting
 *  silence reads as the skip having failed. */
export async function skipNext(): Promise<void> {
  cancelCrossfade(); // a manual skip isn't a crossfade — kill any overlap
  publishStep(1); // show the committed track NOW, before the engine catches up
  // publishStep already moved the mirror — warm the track it's now pointing
  // at before the engine even starts skipping to it.
  warmStream(sourceTrackFor(trackSnapshot), currentQuality());
  try {
    await TrackPlayer.skipToNext();
    await TrackPlayer.play();
  } catch {
    // The skip didn't happen (queue changed under us) — take the optimistic
    // title back rather than leaving the UI showing a song that never started.
    await refreshEngineMirror();
    publishTrack(engineQueue[activeIndex] ?? null);
  }
}

/** Restart the track first; only jump back when already near the start — the
 *  behaviour every other player has, so one stray tap can't lose your place. */
export async function skipPrevious(): Promise<void> {
  cancelCrossfade();
  try {
    const pos = await TrackPlayer.getPosition();
    if (pos > 3) {
      await TrackPlayer.seekTo(0);
      return;
    }
    // Only publish once we know this is a real track change, not a restart.
    publishStep(-1);
    warmStream(sourceTrackFor(trackSnapshot), currentQuality());
    await TrackPlayer.skipToPrevious();
    await TrackPlayer.play();
  } catch {
    await TrackPlayer.seekTo(0);
    await refreshEngineMirror();
    publishTrack(engineQueue[activeIndex] ?? null);
  }
}

/**
 * Shuffle is a real TOGGLE, not a re-roll on every tap.
 *
 * ON  → remember the upcoming order, then shuffle it.
 * OFF → put the remembered order back.
 *
 * Turning it off restoring the order is what makes it a toggle (Spotify's is);
 * the old version shuffled again on every press, which both read as "still on"
 * and left songs playing in an order the user never chose.
 *
 * The ON/OFF flag lives HERE, not in each screen. The player sheet and the
 * playlist screen each held their own useState, so shuffling from one left the
 * other's icon stale — and either one could disagree with the queue that was
 * actually shuffled. One store, both read it.
 */
let preShuffleUpcoming: RNTPTrack[] | null = null;
let shuffleOn = false;
const shuffleListeners = new Set<() => void>();

function setShuffleFlag(on: boolean) {
  if (shuffleOn === on) {
    return;
  }
  shuffleOn = on;
  shuffleListeners.forEach(l => l());
}

export function isShuffled(): boolean {
  return shuffleOn;
}

export function useShuffle(): boolean {
  return useSyncExternalStore(
    l => {
      shuffleListeners.add(l);
      return () => shuffleListeners.delete(l);
    },
    () => shuffleOn,
  );
}

export async function setShuffle(on: boolean): Promise<void> {
  const queue = await TrackPlayer.getQueue();
  const index = await TrackPlayer.getActiveTrackIndex();
  if (index == null) {
    return;
  }
  const rest = queue.slice(index + 1);
  if (on) {
    if (rest.length < 2) {
      // Nothing to shuffle — leave the flag alone so the icon doesn't claim a
      // shuffle that never happened.
      return;
    }
    preShuffleUpcoming = rest; // remember so OFF can restore it
    const shuffled = [...rest];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    await TrackPlayer.removeUpcomingTracks();
    await TrackPlayer.add(shuffled);
    setShuffleFlag(true);
  } else {
    if (preShuffleUpcoming) {
      await TrackPlayer.removeUpcomingTracks();
      await TrackPlayer.add(preShuffleUpcoming);
      preShuffleUpcoming = null;
    }
    setShuffleFlag(false);
  }
  await refreshEngineMirror();
}

export async function setRepeat(mode: RepeatMode): Promise<void> {
  await TrackPlayer.setRepeatMode(mode);
}

/**
 * Pause/resume from the engine's own state, so the UI, the notification and a
 * headset button can never disagree about what a press should do.
 *
 * Buffering/Loading count as "already going" — otherwise tapping during the
 * spin-up between tracks would start a SECOND play and leave the button
 * showing the opposite of reality.
 */
/** Stop playback outright — used by the sleep timer. */
export async function pausePlayback(): Promise<void> {
  cancelCrossfade(); // silence any overlap too, or it keeps sounding alone
  setPausedByDuck(false);
  try {
    await TrackPlayer.pause();
  } catch {
    /* engine already gone */
  }
}

export async function togglePlay(): Promise<void> {
  const {state} = await TrackPlayer.getPlaybackState();
  const active =
    state === State.Playing ||
    state === State.Buffering ||
    state === State.Loading;
  // The user just made the call, so ducking no longer owns this pause — without
  // this, a focus regain later could resume music they had stopped by hand.
  setPausedByDuck(false);
  if (active) {
    cancelCrossfade(); // pausing must silence the overlap player too
    await TrackPlayer.pause();
  } else {
    await TrackPlayer.play();
  }
}

export async function stop(): Promise<void> {
  cancelCrossfade();
  try {
    await TrackPlayer.reset();
    clearResume(); // an explicit stop means "don't reopen on this"
  } catch {
    /* engine not up — nothing to stop */
  }
}

export async function seekTo(seconds: number): Promise<void> {
  await TrackPlayer.seekTo(seconds);
}

/**
 * Autoplay radio: when the queue is nearly out, fetch songs similar to what's
 * playing and append them — playback continues endlessly, like the WebView
 * build (and Spotify). Tracks are tagged `_autoplay` so the queue screen can
 * label them "Recommended".
 *
 * Runs off the same 1s watcher tick as the crossfade, so there is exactly one
 * background timer for playback upkeep.
 */
let radioBusy = false;

async function topUpFromRadio(): Promise<void> {
  if (radioBusy || !readSettings().autoplay) {
    return;
  }
  const [queue, index] = await Promise.all([
    TrackPlayer.getQueue(),
    TrackPlayer.getActiveTrackIndex(),
  ]);
  if (!queue.length || index == null || queue.length - index > 2) {
    return;
  }
  const seed =
    sourceTrackFor(queue[index]) ?? queueSource[queueSource.length - 1];
  if (!seed) {
    return;
  }
  radioBusy = true;
  try {
    const seen = new Set(queueSource.map(getTrackId));
    const picks: Track[] = (
      await getRadio(cleanText(seed.title), cleanText(seed.artist))
    )
      .map(raw => normalizeTrack(raw))
      .filter(
        (t): t is Track =>
          !!t && isPlayableTrack(t) && !seen.has(getTrackId(t)),
      )
      .slice(0, 8)
      .map(t => ({...t, _autoplay: true}));
    const items = picks
      .map(t => ({t, q: toQueueItem(t, currentQuality())}))
      .filter(x => x.q !== null);
    if (items.length) {
      await TrackPlayer.add(items.map(x => x.q!));
      queueSource = [...queueSource, ...items.map(x => x.t)];
    }
  } catch {
    // Radio is a bonus — never let it surface as an error.
  } finally {
    radioBusy = false;
  }
}

/**
 * Warm the next track's stream once we're ~3s into the current one. Resolving
 * the source (source id -> signed CDN URL) is the slow part of a skip; doing it
 * ahead of time on the backend's cache makes the skip feel instant. Downloaded
 * tracks need no warming (they're a local file), and each next-track is warmed
 * at most once.
 */
let prefetchedFor = '';

async function prefetchNext(): Promise<void> {
  try {
    const {position} = await TrackPlayer.getProgress();
    if (position < 3) {
      return;
    }
    const idx = await TrackPlayer.getActiveTrackIndex();
    if (idx == null) {
      return;
    }
    const key = `${idx}`;
    if (prefetchedFor === key) {
      return;
    }
    const next = queueSource[idx + 1];
    if (!next || next.file_path) {
      prefetchedFor = key;
      return;
    }
    prefetchedFor = key;
    await getStreamInfo(next, currentQuality());
  } catch {
    // Best-effort — a failed warm just means the skip resolves normally.
  }
}

/**
 * Fade between songs.
 *
 * NOT a true crossfade, and the setting's hint says so. A real one overlaps two
 * streams, which needs two players; ExoPlayer here is a single output, so this
 * fades the outgoing track down and the next one back up. The gap is what a
 * second player would have filled.
 *
 * Runs off the progress tick rather than a timer so it can't drift from the
 * audio, and re-arms per track via `fadedFor`.
 */
let fadeTimer: ReturnType<typeof setInterval> | null = null;
let fadedFor = '';
// True while the native overlap player is running toward a handoff — a REAL
// crossfade (two songs audible at once) rather than the fade-down/up fallback.
//
// There is no `fadeGen` generation counter any more: it existed to let one JS
// ramp abort another mid-flight. Ramps are native now and the native side owns
// its own cancellation, so a counter here would guard nothing.
let cfActive = false;

/**
 * Tear down a running crossfade WITHOUT the handoff seek — for a manual skip or
 * stop, where the user is choosing the next track rather than letting the queue
 * flow into it. Restores full volume so the chosen track isn't left quiet.
 */
function cancelCrossfade(): void {
  cfActive = false;
  endCrossfade();
  // ALWAYS restore full volume, natively — a fade-down that never reached its
  // handoff (backgrounded mid-fade, the setting toggled off, a pause on the
  // last second) must not leave the engine stuck quiet.
  restorePlayerVolume();
  TrackPlayer.setVolume(1).catch(() => {});
}

/**
 * The overlap reached the track boundary. RNTP has just advanced to the
 * incoming track at position 0, still quiet from the fade-down. Seek it to
 * where the overlap player has reached — under cover of that player's audio, so
 * the re-buffer is inaudible — bring RNTP back to full, THEN cut the overlap.
 */
async function handoffCrossfade(): Promise<void> {
  cfActive = false;
  try {
    const pos = await crossfadePosition();
    if (pos > 0.5) {
      await TrackPlayer.seekTo(pos);
      // Wait for RNTP to actually be ready to play at that position, rather
      // than a blind fixed pause. A flat 250ms was a guess: fine on a warm
      // buffer, but on a slow network the re-buffer after the seek can run
      // longer — and cutting the overlap before RNTP catches up is exactly the
      // "brief silence, then the song plays" gap this used to leave, ONLY on
      // crossfaded transitions (a plain track change never seeks mid-buffer
      // like this). Poll briefly instead; the 250ms cap keeps the worst case
      // no worse than before.
      const deadline = Date.now() + 900;
      while (Date.now() < deadline) {
        try {
          const {state} = await TrackPlayer.getPlaybackState();
          if (state === State.Playing || state === State.Ready) {
            break;
          }
        } catch {
          break;
        }
        await new Promise(r => setTimeout(r, 60));
      }
    }
  } catch {}
  // ORDER MATTERS. Cut the overlap BEFORE bringing RNTP back to full: both are
  // playing the same incoming track a little out of step, so any window where
  // both are loud is heard as the song doubled over itself. Restoring first and
  // stopping second (what this used to do, with a 250ms gap between) is exactly
  // the "sound clashes, I hear it twice for a second" report.
  await endCrossfade();
  try {
    await TrackPlayer.setVolume(1);
  } catch {}
  restorePlayerVolume(); // cancel the native fail-safe; it has nothing left to do
}

/**
 * Put the incoming track at FULL volume on every track change.
 *
 * This used to be a JS ramp (setVolume in a setTimeout loop) and that was the
 * "volume drops on auto-advance and stays low" bug: Android throttles RN's JS
 * timers once the app is backgrounded or the screen locks, so the loop stalled
 * part way and the volume simply stayed there — then crept back up when
 * reopening the app thawed the thread.
 *
 * The reference build (WebView) never touches volume on a normal transition,
 * and that is the behaviour restored here: one idempotent assertion of full
 * volume, no timers, plus the native restore so it holds even if the bridge is
 * frozen. Fading is now exclusively the native crossfade's job.
 */
async function restoreFullVolume(): Promise<void> {
  restorePlayerVolume(); // cancels any native ramp, then sets 1.0
  try {
    await TrackPlayer.setVolume(1);
  } catch {}
}

export function startCrossfadeWatcher(getSeconds: () => number): void {
  if (fadeTimer) {
    return;
  }
  fadeTimer = setInterval(async () => {
    // Piggybacked on this tick: keep the queue topped up with similar songs.
    topUpFromRadio().catch(() => {});

    // …and warm the NEXT track's stream a few seconds in, so pressing skip (or
    // an auto-advance) plays instantly instead of resolving the source cold.
    // getStreamInfo caches exactly what proxy_stream reuses a beat later.
    prefetchNext().catch(() => {});

    // …and remember the current position, throttled inside saveResume, so a
    // reopen resumes at the timestamp you left rather than the song's start.
    try {
      const {position} = await TrackPlayer.getProgress();
      const idx = (await TrackPlayer.getActiveTrackIndex()) ?? 0;
      const src = sourceTrackFor((await TrackPlayer.getActiveTrack()) ?? null);
      if (src) {
        saveResume({track: src, position, queue: queueSource, index: idx});
      }
    } catch {}

    const span = getSeconds();
    // Crossfade only while the app is actually on screen. The handoff that ends
    // an overlap (seek RNTP to the overlap position, then cut it) is JS work,
    // and JS is exactly what Android stops running in the background — a fade
    // started there would hand off to nobody, leaving the overlap player and
    // RNTP both audible. Backgrounded, tracks change the plain way: untouched
    // volume, which is what the WebView build did on every transition anyway.
    if (span <= 0 || AppState.currentState !== 'active') {
      return;
    }
    try {
      const {position, duration} = await TrackPlayer.getProgress();
      const active = await TrackPlayer.getActiveTrackIndex();
      const key = `${active}`;
      if (duration <= 0 || position <= 0) {
        return;
      }
      const remaining = duration - position;

      if (remaining <= span && fadedFor !== key) {
        fadedFor = key;
        // Ramp the outgoing track DOWN over its final `span` seconds. The
        // incoming track is put back to full by restoreFullVolume() on the
        // track change (and by the native ramp's own fail-safe).

        // Real crossfade: start the SECOND stream on the incoming track, rising,
        // so it overlaps this fade-down. Only if the build supports it and the
        // next track's stream URL is known; otherwise this degrades to a plain
        // fade-down with full volume restored on the track change.
        if (crossfadeSupported && !cfActive && active != null) {
          try {
            const q = await TrackPlayer.getQueue();
            const nextUrl = q[active + 1]?.url;
            const repeatOne =
              (await TrackPlayer.getRepeatMode()) === RepeatMode.Track;
            if (
              nextUrl &&
              !repeatOne &&
              (await beginCrossfade(String(nextUrl), Math.round(span * 1000)))
            ) {
              cfActive = true;
            }
          } catch {
            /* couldn't resolve the next stream — plain fade it is */
          }
        }

        // The ramp itself runs NATIVELY (Handler, not a JS timer) so it cannot
        // stall half way down when the app is backgrounded, and it restores
        // full volume by itself once the boundary passes.
        fadeOutPlayer(Math.round(span * 1000));
      } else if (remaining > span + 1 && fadedFor === key) {
        // Seeked backwards out of the fade zone — cancel it and go back to full.
        fadedFor = '';
        cancelCrossfade(); // drops the overlap AND restores volume natively
      }
    } catch {
      /* engine not up */
    }
  }, 1000);
}

/**
 * Is the player playing — but STABLE across a seek.
 *
 * Seeking makes ExoPlayer flash through Buffering/Loading/Ready before it
 * settles back to Playing, and reading the raw state made the play/pause icon
 * blink pause→play→pause on every scrub. Only the definite states flip this;
 * the transient ones hold the last real intent.
 */
export function useIsPlaying(): boolean {
  const {state} = usePlaybackState() as {state?: State};
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (state === State.Playing) {
      setPlaying(true);
    } else if (
      state === State.Paused ||
      state === State.Stopped ||
      state === State.Ended ||
      state === State.None ||
      state === State.Error
    ) {
      setPlaying(false);
    }
    // Buffering / Loading / Ready / Connecting: leave the icon as-is.
  }, [state]);
  return playing;
}

export {TrackPlayer, State, Event, RepeatMode};
// Re-exported so screens import playback from one module rather than reaching
// into the library directly — which is what lets the guards above stay honest.
// NOTE: useActiveTrack is OURS (defined above), not RNTP's — it publishes
// optimistically on a committed gesture instead of waiting for the engine event.
export {usePlaybackState, useProgress} from 'react-native-track-player';
