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
import {AppState, Image} from 'react-native';
import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  Event,
  RepeatMode,
  State,
  usePlaybackState,
  useProgress as useProgressPolled,
  type Track as RNTPTrack,
} from 'react-native-track-player';
import {apiUrl, getRadio, getStreamInfo, type Track} from './backend';
import {currentQuality, readSettings, writeSetting} from './store';
import {
  cleanText,
  getBestArtworkUrl,
  getDownloadKey,
  isPlayableTrack,
  normalizeTrack,
} from './tracks';
import {getArtworkColor} from './artworkColor';
import {logEvent, songParams} from './analytics';
import {
  applyAudioEffects,
  endCrossfade,
  fadeInPlayer,
  fadeOutPlayer,
  restorePlayerVolume,
  setCrossfade,
} from './audioEffects';
import {setPausedByDuck} from './duckState';
import {
  sleepTimerOnPause,
  sleepMode,
  sleepTimerOnTrackChange,
} from './sleepTimer';
import {remember} from './recentlyPlayed';
import {clearResume, readResume, resumeIndex, saveResume} from './resume';

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

/**
 * How long the native volume ramp at the start of a track takes.
 *
 * Deliberately short. Past ~200ms a rise stops reading as "a clean start" and
 * starts reading as a fade, which is not what this is for — it exists to cover
 * the first few frames while ExoPlayer's output path settles, not to be noticed.
 */
const FADE_IN_MS = 130;
/**
 * The ramp on a SKIP, which is a tenth of the one on a fresh start.
 *
 * It is there for the same reason — ExoPlayer opening its output clicks — but a
 * skip is a button press waiting on a response, and 130ms of rise on top of the
 * engine's own latency reads as the button being slow. Forty is enough to
 * swallow the transient and is below the threshold where a rise is audible AS
 * one.
 */
const SKIP_FADE_MS = 40;

/**
 * How recently a manual skip has to have happened for the next track change to
 * count as that skip rather than as a song ending.
 */
const MANUAL_STEP_WINDOW_MS = 2000;
let manualStepAt = 0;

/** Called by anything that changes track because the USER said so. */
export function markManualTrackChange(): void {
  manualStepAt = Date.now();
}

/**
 * The one place playback resumes from silence.
 *
 * The ramp used to live in playTrack alone, which made tapping a song smooth
 * and left every other route in raw: resuming a restored session, the play
 * button, the notification, a headset click, a queue row, both skips. The
 * transient it hides belongs to ExoPlayer opening its output, so it belongs
 * wherever that happens rather than wherever a track is chosen.
 *
 * setVolume is awaited so the floor is in place before play() rather than
 * racing it.
 */
export async function playWithFade(ms: number = FADE_IN_MS): Promise<void> {
  await TrackPlayer.setVolume(1);
  await fadeInPlayer(ms);
  await TrackPlayer.play();
}

/**
 * Stop, but by receding rather than by cutting.
 *
 * Only the sleep timer uses this. Everything else that pauses is a button
 * press, where anything but an instant stop reads as lag.
 */
export async function fadeToPause(ms = 2500): Promise<void> {
  cancelCrossfade();
  setPausedByDuck(false);
  await fadeOutPlayer(ms);
  // The native ramp restores 1.0 by itself once it completes, so the next play
  // does not start silent.
  setTimeout(() => {
    TrackPlayer.pause().catch(() => {});
  }, ms);
}

/**
 * WHERE the current queue was started from — a collection id, or ''.
 *
 * The library used to answer "am I listening to this?" by asking whether the
 * playing song was CONTAINED in each collection, which is a different question
 * with a different answer: a song in Liked Songs, a playlist and Downloads made
 * all three go green at once. Containment cannot distinguish them; only the
 * origin can, and only playTrack knows it.
 *
 * Cleared whenever a queue is built from anywhere else, so it can never outlive
 * the thing it describes. Autoplay/radio top-ups deliberately do NOT clear it:
 * the queue genuinely did start there, and the highlight should survive the
 * album running out.
 */
let playbackOrigin = '';
const originListeners = new Set<() => void>();

function setPlaybackOrigin(id: string): void {
  if (playbackOrigin === id) {
    return;
  }
  playbackOrigin = id;
  originListeners.forEach(l => l());
}

/** Subscribe to the origin. A string snapshot, so useSyncExternalStore bails
 *  out on an unchanged value and nothing re-renders. */
export function usePlaybackOrigin(): string {
  return useSyncExternalStore(
    l => {
      originListeners.add(l);
      return () => originListeners.delete(l);
    },
    () => playbackOrigin,
  );
}

/**
 * The queue itself changed — reordered, shuffled, topped up, rebuilt.
 *
 * PlaybackActiveTrackChanged was the only signal the queue screen had, and
 * shuffle is the case that proves it insufficient: it reorders everything AFTER
 * the active track, by design, so the active track does not change and the
 * event never fires. The engine really had shuffled; the list was rendering a
 * snapshot taken before it.
 */
const queueListeners = new Set<() => void>();

export function onQueueChanged(l: () => void): () => void {
  queueListeners.add(l);
  return () => {
    queueListeners.delete(l);
  };
}

/**
 * One queue mutation at a time.
 *
 * Every mutation below is a read-modify-write over several awaited bridge
 * calls (read the queue, remove, add, refresh). Nothing ordered one against
 * the next, so a second drop landing between another's remove and add read a
 * queue one item short and moved the wrong track — and a radio top-up
 * appending mid-move made its "is this the last slot" test use a stale length.
 * Chained here, each one sees the queue the previous one left.
 *
 * Exported for the test.
 */
let queueOps: Promise<unknown> = Promise.resolve();
export function serialQueueOp<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueOps.then(fn);
  queueOps = run.catch(() => {});
  return run;
}

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
      // No progressUpdateEventInterval: nothing listens for that event, and it
      // woke JS every second of playback, screen off included. The bars read
      // position with useProgress, which polls only while they are mounted.
    });
    await TrackPlayer.setRepeatMode(RepeatMode.Off);

    // Every track the engine lands on — auto-advance, radio, a queue tap —
    // goes into Recently Played AS IT STARTS, so Home updates live. Manual
    // playTrack() also records (first write wins on order; remember() de-dupes).
    // The end-of-track sleep stop is ExoPlayer pausing itself on the last
    // frame (setPauseAtEndOfTrack). This notices that pause — a native event,
    // so it arrives with the screen off — and clears the timer, so the next
    // press of play carries on normally.
    TrackPlayer.addEventListener(Event.PlaybackState, async e => {
      if (e.state !== State.Paused || sleepMode() !== 'endOfTrack') {
        return;
      }
      try {
        const {position, duration} = await TrackPlayer.getProgress();
        sleepTimerOnPause(duration > 0 && duration - position < 1.5);
      } catch {}
    });

    TrackPlayer.addEventListener(Event.PlaybackError, e => {
      logEvent('playback_error', {message: e.message, code: e.code});
    });

    TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, async e => {
      // The "play this soon" window is relative to the current song — a new song
      // starts a fresh one, so anything queued now goes right after it again.
      queuedAhead = 0;
      // The engine is authoritative — reconcile the optimistic mirror with what
      // actually started, and keep the queue snapshot warm for the next gesture.
      publishTrack(e.track ?? null);
      // A native event, so the sleep timer's deadline is honoured even when the
      // screen has been off long enough for JS timers to be throttled. This is
      // the BACKSTOP for end-of-track; the punctual stop is armed by the
      // watcher two seconds out. Only an automatic advance consumes the timer —
      // pressing next with one armed is not a request to stop now.
      sleepTimerOnTrackChange(
        Date.now() - manualStepAt > MANUAL_STEP_WINDOW_MS,
      );
      // Autoplay top-up rides the same native event, for the same reason.
      //
      // It used to be driven ONLY by the 1s JS interval in
      // startCrossfadeWatcher — and Android freezes JS timers once the app is
      // backgrounded or the screen is off, which this file already documents
      // for the old volume ramp. So the last song of a queue ended with the
      // screen off, the tick never fired, nothing was appended, and playback
      // just stopped. Pressing next thawed the JS thread, the tick finally ran,
      // and the queue filled — exactly the "it only continues after I press
      // skip" report.
      //
      // Cheap to call: topUpFromRadio() returns immediately unless the queue is
      // nearly out.
      topUpFromRadio().catch(() => {});
      const src = sourceTrackFor(e.track ?? null);
      if (src) {
        remember(src);
        logEvent('song_played', songParams(src));
      }
      // Re-read the mirror, warm the covers around the new track and save the
      // session — once the skipping stops. Everything above this line has
      // already run, so the UI is current; this is the expensive half.
      onTrackSettled(() => {
        (async () => {
          try {
            const idx = (await TrackPlayer.getActiveTrackIndex()) ?? 0;
            await refreshEngineMirror(idx);
            // Recomputed rather than captured: by the time this runs the
            // active track may be several skips further on, and writing the
            // one that was current when the burst started would resume to the
            // wrong song.
            saveResume(
              {
                track: sourceTrackFor(engineQueue[idx] ?? null),
                position: 0,
                queue: queueSource,
                index: idx,
              },
              true,
            );
          } catch {}
        })().catch(() => {});
      });
      // No volume or crossfade work here any more. The handoff is the native
      // scheduler's (AudioModule.cfStep), and this event can land while an
      // overlap is still sounding — restoring full volume from here, as this
      // used to, would play the incoming song twice at once.
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
    .map((t, from) => ({t, from, q: toQueueItem(t, currentQuality())}))
    .filter(x => x.q !== null);
  if (!items.length) {
    return false;
  }
  try {
    queueSource = items.map(x => x.t);
    // By the saved TRACK, not the bare index: dropping an unplayable entry
    // above shifts every later index by one.
    const idx = resumeIndex(
      items.map(x => ({title: x.t.title, artist: x.t.artist, from: x.from})),
      s,
    );

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
    // Awaited. A restored session sits paused, so there IS time to attach the
    // chain properly — and an effects chain that attaches after audio is
    // already out is exactly what the step change on resume sounds like.
    await applyAudioEffects();
    await applyPlaybackRate();
    // Seed the now-playing mirror. A restored session is left PAUSED, so no
    // track-change event fires — without this the mini player would sit blank
    // until the user pressed play (RNTP's own hook self-seeded on mount; ours
    // has to be told).
    await refreshEngineMirror();
    // The cover and the bar's colour BEFORE the track is published, so the
    // mini player arrives finished under the splash instead of filling in
    // after it lifts. Capped: a slow network costs at most 1.2s, then the bar
    // shows what it has, exactly as before.
    const art = getBestArtworkUrl(items[idx].t);
    if (art) {
      await Promise.race([
        Promise.all([
          Image.prefetch(art).catch(() => false),
          getArtworkColor(art).catch(() => null),
        ]),
        new Promise(r => setTimeout(r, 1200)),
      ]);
    }
    publishTrack(engineQueue[activeIndex] ?? null);
    // The earlier tracks come back AFTER the player is on screen, prepended so
    // Previous still works; this shifts the active index to idx without ever
    // showing track 0.
    //
    // Deferred rather than awaited above, because its cost is proportional to
    // how far into the queue you were: a 200-track playlist left at index 180
    // serialises 180 items across the bridge before the first frame can render.
    // Previous is not reachable in the time this takes — the player has to be
    // drawn before it can be pressed.
    if (idx > 0) {
      setTimeout(() => {
        (async () => {
          await TrackPlayer.add(
            items.slice(0, idx).map(x => x.q!),
            0,
          );
          // And re-sync, because the mirror above was taken from the queue as
          // it was BEFORE the prepend: it holds n-idx tracks with the active
          // one at 0, while the engine now holds all n with the active one at
          // idx. Left stale, Previous has nothing behind it and the queue sheet
          // renders the tail of the queue as the whole of it.
          await refreshEngineMirror();
          publishTrack(engineQueue[activeIndex] ?? null);
        })().catch(() => {});
      }, 0);
    }
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

/**
 * A counter, because the queue needs to tell two copies of one song apart.
 *
 * `id` is title+artist, which is the right identity for "is this the same
 * song" and completely wrong as a list key: queue a track three times and all
 * three rows claim the same key. DraggableFlatList tracks the lifted cell BY
 * KEY, so all three lifted together, VirtualizedList collapsed them into one
 * cell registry entry, and the drop index came back for the wrong row — which
 * is how a song dropped second ended up playing much later.
 *
 * Never reset. It only has to be unique within a process, and RNTP round-trips
 * unknown keys through the native queue untouched (Track has an index
 * signature, and getQueue() resolves each track's original bundle).
 */
let queueSeq = 0;

function toQueueItem(track: Track, bitrate: number) {
  const url = streamUrlFor(track, bitrate);
  if (!url) {
    return null;
  }
  return {
    id: `${track.title}-${track.artist}`,
    /** Identity of this ROW, as opposed to `id`, the identity of the song. */
    _qid: `q${++queueSeq}`,
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
  /** The collection this was launched from — see playbackOrigin. '' for a
   *  search result, a radio pick, or a single tap with no list behind it. */
  originId = '',
): Promise<void> {
  await requireEngine();
  setPlaybackOrigin(originId);
  // Was a fourth parameter defaulting to exactly this, which nothing ever
  // passed. With originId inserted BEFORE it, playTrack(t, list, 320) would
  // have quietly taken 320 as a collection id and still used the default
  // bitrate — and TypeScript could not have said so, because a number is a
  // perfectly good string index for nothing. A local is not a trap.
  const bitrate = currentQuality();

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

  buildingQueue = true;

  cancelCrossfade(); // and guarantee full volume for the fresh track
  // A brand-new queue is in the order the user picked — shuffle no longer
  // describes anything, so the icon must go back to off.
  preShuffleUpcoming = null;
  setShuffleFlag(false);

  try {
    await TrackPlayer.reset();

    // ONLY the tapped track goes over the bridge before play() — the rest of the
    // queue follows after the music has already started.
    //
    // This is the "why does starting a song from a playlist take so long" gap.
    // Every track in the context was serialised across the RN bridge and handed
    // to ExoPlayer BEFORE play() was even called, so tapping song 3 of a 60-track
    // album paid for all 60 first. The wait scaled with the size of the list you
    // happened to be looking at, which is why it felt fine from a search result
    // and slow from an album — the same tap, wildly different delay.
    //
    // ExoPlayer appends and prepends to a playing queue perfectly happily, so the
    // rest costs nothing once sound is out.
    await TrackPlayer.add([items[startAt].q]);

    // Full volume, always — but the RISE is native.
    //
    // The warning this comment used to carry still stands and is the reason the
    // ramp is where it is: a ramp written in JS stalls the instant Android
    // throttles RN's timers, and leaves the track stuck quiet. That is not a
    // cosmetic bug and it must never come back. A ramp on the audio thread
    // cannot stall, and it force-restores 1.0 afterwards either way.
    //
    // What it hides is the start-of-stream transient: ExoPlayer has just opened
    // the output, a Bluetooth codec is still negotiating, and the effects chain
    // attaches a beat later. FADE_IN_MS is under the threshold where a rise is
    // perceptible AS a fade — it reads as a clean start, not a fade-in.
    // Publish the tapped track immediately — waiting for the engine event showed
    // the old song's title for a beat. The mirror is seeded from the FULL list we
    // are about to build, not from the one-track queue that exists right now, so
    // an instant swipe still peeks at the correct neighbour.
    engineQueue = items.map(x => x.q as RNTPTrack);
    activeIndex = startAt;
    publishTrack(engineQueue[startAt] ?? null);
    warmArtwork(startAt);
    await playWithFade();

    // The rest of the queue, now that the song is audible. After: everything the
    // tapped track came before. Before: the earlier tracks, so Previous works —
    // inserting at 0 shifts the active track down without ever surfacing track 0.
    if (items.length > 1) {
      if (startAt < items.length - 1) {
        await TrackPlayer.add(items.slice(startAt + 1).map(x => x.q));
      }
      if (startAt > 0) {
        await TrackPlayer.add(
          items.slice(0, startAt).map(x => x.q),
          0,
        );
      }
      // The track-change event for the tapped song may already have refreshed the
      // mirror from the one-track queue. Re-sync now that the real queue exists,
      // or a skip straight after a tap would find nothing to skip to.
      await refreshEngineMirror();
    }
  } finally {
    // Whatever happened, autoplay must be allowed to top the queue up again.
    buildingQueue = false;
  }

  // Recorded at play-START, before enrichment runs. remember() replaces an
  // existing entry rather than appending, so the cleaned-up version wins later.
  remember(items[startAt].t);

  // Android destroys audio effects along with the audio session, so the EQ has
  // to be re-attached each time playback starts — otherwise the setting works
  // for exactly one song and then silently stops. Speed rides along for the
  // same reason: reset() clears it.
  applyAudioEffects();
  applyPlaybackRate();
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
  return serialQueueOp(() => insertQueued(track, item));
}

async function insertQueued(
  track: Track,
  item: NonNullable<ReturnType<typeof toQueueItem>>,
): Promise<void> {
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
  // Inserted at the same offset as the engine, not appended.
  //
  // The mirror is read BY INDEX in places — prefetchNext warms
  // queueSource[idx + 1] — so appending a track the engine put three rows
  // below the current song left the two lists disagreeing from that point on,
  // and the warm went to whatever happened to be last.
  queueSource = [...queueSource.slice(0, at), track, ...queueSource.slice(at)];
  // And the ENGINE mirror, which is a different thing again.
  //
  // Without this, addToQueue was the one mutation that did not end here, and
  // two reports followed from it. The open queue sheet never repainted, because
  // queueListeners fire only from this function. And pressing next published
  // the wrong song: publishStep reads engineQueue[activeIndex + 1] to show the
  // next title immediately, so it announced whatever was next BEFORE the
  // insert and then snapped to the real one when the engine's own event landed.
  await refreshEngineMirror();
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
export function moveQueueItem(from: number, to: number): Promise<boolean> {
  if (from === to) {
    return Promise.resolve(true);
  }
  return serialQueueOp(() => moveQueueItemNow(from, to));
}

async function moveQueueItemNow(from: number, to: number): Promise<boolean> {
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
    // Once the queue has been reordered by hand, "the block I queued after the
    // current song" is no longer a block — the user may have dragged a track
    // straight out of it. Keeping the count would land the next "add to queue"
    // one slot too far down, so it goes back to inserting directly after the
    // current song.
    queuedAhead = 0;
    await TrackPlayer.remove([from]);
    // `to` indexes the queue as it is AFTER the removal (length n-1), which is
    // the same convention as splice. The last slot has no element to insert
    // before, so it has to be an append rather than an insert.
    if (to >= q.length - 1) {
      await TrackPlayer.add([item]);
    } else {
      await TrackPlayer.add([item], to);
    }
    // Same move in the mirror, for the same reason as the insert above: it is
    // indexed against the engine queue, so a reorder the engine performed and
    // the mirror did not is a mirror that lies from then on.
    if (from < queueSource.length) {
      const moved = queueSource[from];
      const rest = [
        ...queueSource.slice(0, from),
        ...queueSource.slice(from + 1),
      ];
      queueSource =
        to >= rest.length
          ? [...rest, moved]
          : [...rest.slice(0, to), moved, ...rest.slice(to)];
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

/**
 * Pull the covers around `index` into the image cache BEFORE anything renders
 * them.
 *
 * Nothing did this, so every cover was fetched cold the moment its <Image>
 * mounted — which is why swiping to the next song showed the title first and
 * the artwork a beat (or, on a weak connection, several) later. The URLs are
 * already sitting in the engine queue; Image.prefetch hands them to Android's
 * own image pipeline, which is the same cache the <Image> reads from, so by the
 * time the swipe commits the bytes are usually already local.
 *
 * One step back and two forward: enough for a swipe in either direction and an
 * auto-advance, without spending a listener's data on a whole album.
 */
const warmedArt = new Set<string>();

function warmArtwork(index: number): void {
  for (let i = index - 1; i <= index + 2; i++) {
    const url = engineQueue[i]?.artwork;
    if (typeof url !== 'string' || !url || warmedArt.has(url)) {
      continue;
    }
    warmedArt.add(url);
    // Bounded: a long session must not hold every cover URL it ever saw.
    if (warmedArt.size > 300) {
      const oldest = warmedArt.values().next().value;
      if (oldest !== undefined) {
        warmedArt.delete(oldest);
      }
    }
    Image.prefetch(url).catch(() => {
      // A cover that won't load is a placeholder, never an error.
    });
  }
}

/** Re-read the engine's queue and index so the mirror is warm before a gesture. */
async function refreshEngineMirror(index?: number): Promise<void> {
  try {
    engineQueue = await TrackPlayer.getQueue();
    activeIndex = index ?? (await TrackPlayer.getActiveTrackIndex()) ?? 0;
    warmArtwork(activeIndex);
    // Here rather than at the five call sites: setShuffle, moveQueueItem,
    // playTrack, restoreSession, topUpFromRadio and both skips ALL end with
    // this, so this is the one place that knows the queue just moved.
    queueListeners.forEach(l => l());
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
  // The song after the one just committed — so a second swipe in the same
  // direction is already warm too.
  warmArtwork(activeIndex);
  return true;
}

/** The track one step away in the mirror, without moving anywhere — what the
 *  swipe-to-change-song gesture previews while the finger is still down. */
export function peekAdjacentTrack(delta: 1 | -1): RNTPTrack | null {
  return engineQueue[activeIndex + delta] ?? null;
}

/**
 * Is THIS title+artist the track currently playing?
 *
 * A BOOLEAN subscription, so a track change re-renders only the row that gained
 * the highlight and the one that lost it. Every list row calling
 * useActiveTrack() instead meant one track change re-rendered every visible row
 * — twenty rows each redoing a pair of toLowerCase comparisons — which is a
 * good part of why scrolling a long list while music played felt sticky.
 *
 * useSyncExternalStore bails out when the snapshot is Object.is-equal, and
 * `false === false`, so the rows that were not involved never re-render.
 */
export function useIsActiveTrack(
  title: string | null | undefined,
  artist: string | null | undefined,
): boolean {
  const t = String(title ?? '').toLowerCase();
  const a = String(artist ?? '').toLowerCase();
  return useSyncExternalStore(
    l => {
      trackListeners.add(l);
      return () => trackListeners.delete(l);
    },
    () =>
      !!trackSnapshot &&
      String(trackSnapshot.title ?? '').toLowerCase() === t &&
      String(trackSnapshot.artist ?? '').toLowerCase() === a,
  );
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
  markManualTrackChange();
  publishStep(1); // show the committed track NOW, before the engine catches up
  // publishStep already moved the mirror — warm the track it's now pointing
  // at before the engine even starts skipping to it.
  warmStream(sourceTrackFor(trackSnapshot), currentQuality());
  try {
    await TrackPlayer.skipToNext();
    await playWithFade(SKIP_FADE_MS);
  } catch {
    // The skip didn't happen (queue changed under us) — take the optimistic
    // title back rather than leaving the UI showing a song that never started.
    await refreshEngineMirror();
    publishTrack(engineQueue[activeIndex] ?? null);
  }
}

/** Restart the track first; only jump back when already near the start — the
 *  behaviour every other player has, so one stray tap can't lose your place.
 *  `always` skips the restart: a swipe has already shown the previous cover
 *  gliding in, so it must land on that song. */
export async function skipPrevious(always = false): Promise<void> {
  cancelCrossfade();
  markManualTrackChange();
  try {
    const pos = await TrackPlayer.getPosition();
    if (!always && pos > 3) {
      await TrackPlayer.seekTo(0);
      return;
    }
    // Only publish once we know this is a real track change, not a restart.
    publishStep(-1);
    warmStream(sourceTrackFor(trackSnapshot), currentQuality());
    await TrackPlayer.skipToPrevious();
    await playWithFade(SKIP_FADE_MS);
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

/**
 * The original order of whatever is STILL upcoming.
 *
 * This is the whole of the shuffle-off bug, and it is worth being explicit
 * about. `preShuffleUpcoming` is a snapshot taken at the moment shuffle was
 * turned on — but the queue keeps moving afterwards. Songs play, so they leave
 * the upcoming list; radio appends more; a swipe skips two at once. Re-adding
 * that snapshot wholesale put songs back that had already been heard and
 * dropped ones added since, so turning shuffle OFF produced a queue that looked
 * every bit as random as turning it on. From the outside both directions
 * reshuffled, and neither ever restored anything.
 *
 * Filtering the snapshot by what is genuinely still ahead fixes it in one line
 * of intent: keep the ORDER from the snapshot, keep the MEMBERSHIP from the
 * live queue. `_qid` is the per-row identity toQueueItem already stamps — the
 * right key here, because the same song queued twice is two rows and only one
 * of them may still be upcoming.
 *
 * Exported for the test; nothing else calls it.
 */
export function restoreOrder<T>(snapshot: T[], liveUpcoming: T[]): T[] {
  // RNTP's Track carries an index signature rather than a declared `_qid`, so
  // the key is read through a cast rather than constrained on T — constraining
  // it would stop the engine's own queue type from being passed at all.
  const qid = (t: T) => (t as {_qid?: unknown})._qid;
  const live = new Set(liveUpcoming.map(qid));
  return snapshot.filter(t => qid(t) !== undefined && live.has(qid(t)));
}

/** Fisher-Yates, and it must not return the identity for a short list — a
 *  shuffle that visibly changes nothing reads as a broken button. */
export function shuffleUpcoming<T>(rest: T[]): T[] {
  const out = [...rest];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Turn shuffle on or off over the UPCOMING tracks.
 *
 * Returns what the engine ACTUALLY did, not what was asked. A queue with
 * nothing ahead of it cannot shuffle, and the caller needs to know that rather
 * than lighting the icon for a shuffle that never happened.
 */
export function setShuffle(on: boolean): Promise<boolean> {
  return serialQueueOp(() => setShuffleNow(on));
}

async function setShuffleNow(on: boolean): Promise<boolean> {
  const queue = await TrackPlayer.getQueue();
  const index = await TrackPlayer.getActiveTrackIndex();
  if (index == null) {
    return shuffleOn;
  }
  const rest = queue.slice(index + 1);
  if (on) {
    if (rest.length < 2) {
      return shuffleOn; // nothing ahead to reorder
    }
    preShuffleUpcoming = rest; // remember so OFF can restore it
    await TrackPlayer.removeUpcomingTracks();
    await TrackPlayer.add(shuffleUpcoming(rest));
    setShuffleFlag(true);
  } else {
    if (preShuffleUpcoming) {
      const restored = restoreOrder(preShuffleUpcoming, rest);
      if (restored.length) {
        await TrackPlayer.removeUpcomingTracks();
        await TrackPlayer.add(restored);
      }
      preShuffleUpcoming = null;
    }
    setShuffleFlag(false);
  }
  await refreshEngineMirror();
  return shuffleOn;
}

/**
 * Drop the radio picks still sitting in the queue.
 *
 * Turning autoplay off stops the top-up from running again, which is all it
 * ever did — but the eight picks appended a few songs ago are already in the
 * queue, so playback carried on into them and the setting looked like it had
 * been ignored. Switching it off now means what it says: nothing plays after
 * what you actually chose.
 *
 * Only tracks AFTER the active one, and only ones tagged `_autoplay` — the
 * song playing right now is not taken out from under the listener even if
 * radio is what queued it.
 */
export function dropQueuedRadio(): Promise<void> {
  return serialQueueOp(dropQueuedRadioNow);
}

async function dropQueuedRadioNow(): Promise<void> {
  try {
    const [queue, index] = await Promise.all([
      TrackPlayer.getQueue(),
      TrackPlayer.getActiveTrackIndex(),
    ]);
    if (index == null) {
      return;
    }
    const doomed = queue
      .map((t, i) => ({t, i}))
      .filter(({t, i}) => i > index && sourceTrackFor(t)?._autoplay)
      .map(({i}) => i);
    if (!doomed.length) {
      return;
    }
    await TrackPlayer.remove(doomed);
    queueSource = queueSource.filter(t => !t._autoplay);
    await refreshEngineMirror();
  } catch {
    // Nothing queued, or the engine is not up — either way there is nothing
    // to prune and no reason to surface it.
  }
}

export async function setRepeat(mode: RepeatMode): Promise<void> {
  await TrackPlayer.setRepeatMode(mode);
}

/**
 * Playback speed.
 *
 * ExoPlayer pitch-corrects, so 1.5x is faster and not higher — which is the
 * only reason a speed control is usable on music at all.
 *
 * Re-applied after every fresh queue for the same reason applyAudioEffects is:
 * TrackPlayer.reset() tears the player's state down, and a rate that survived
 * one song and then quietly went back to normal would be worse than no control.
 */
export async function applyPlaybackRate(): Promise<void> {
  try {
    await TrackPlayer.setRate(playbackRate());
  } catch {
    /* engine not up — the next play applies it */
  }
}

/** The current speed, clamped to the range the UI offers. Read in the
 *  crossfade watcher too, where it converts media seconds to real ones. */
export function playbackRate(): number {
  const r = readSettings().playbackRate;
  return Number.isFinite(r) && r > 0 ? Math.min(2, Math.max(0.25, r)) : 1;
}

/** Change the speed and make it take effect now. */
export async function setPlaybackRate(rate: number): Promise<void> {
  writeSetting('playbackRate', Math.min(2, Math.max(0.25, rate)));
  await applyPlaybackRate();
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
    await playWithFade();
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
/**
 * Run something once a burst of track changes has STOPPED.
 *
 * Mashing next fires PlaybackActiveTrackChanged per skip, and each one used to
 * re-read the whole engine queue across the bridge, prefetch up to four cover
 * images and write the resume file. Ten skips meant ten of each — all of it
 * work about tracks the user was passing through, none of it cancelled when
 * the next skip arrived, and all of it on the thread that also has to draw.
 *
 * The skip itself stays instant: the title, the artwork URL and the transport
 * still update on the event. Only the WARMING waits.
 */
let settleTimer: ReturnType<typeof setTimeout> | null = null;

function onTrackSettled(fn: () => void): void {
  if (settleTimer) {
    clearTimeout(settleTimer);
  }
  settleTimer = setTimeout(() => {
    settleTimer = null;
    fn();
  }, 350);
}

/** True only for the few milliseconds playTrack spends filling the queue in
 *  behind an already-playing first track. */
let buildingQueue = false;

/** Exported for the playback service's PlaybackQueueEnded backstop — that
 *  runs outside the UI, which is exactly when the JS timer is frozen. */
export async function topUpFromRadio(): Promise<void> {
  // buildingQueue: playTrack starts the song on a one-track queue and appends
  // the rest a moment later. Without this, a watcher tick landing in that gap
  // sees "only one track left" and appends radio picks BETWEEN the tapped song
  // and the rest of its own album.
  // sleepMode: arming end-of-track on the last queued song would otherwise
  // append eight more. Harmless once the pause lands — but it means the queue
  // you wake up to is not the one you went to sleep on.
  if (
    radioBusy ||
    buildingQueue ||
    !readSettings().autoplay ||
    sleepMode() === 'endOfTrack'
  ) {
    return;
  }
  // Claimed BEFORE the first await, and everything that can return early moved
  // inside the try so the finally always releases it.
  //
  // The flag used to be set after the queue read, which left an await between
  // the check and the claim — and there are two callers a skip apart: the
  // PlaybackActiveTrackChanged handler and the crossfade watcher's tick. Both
  // could pass the guard, both fetch radio, and both append eight picks
  // deduped against the same pre-append snapshot. That is where the five
  // copies of one song in a queue came from.
  radioBusy = true;
  try {
    const [queue, index] = await Promise.all([
      TrackPlayer.getQueue(),
      TrackPlayer.getActiveTrackIndex(),
    ]);
    // Three songs of headroom, not two. Radio is a live network call; starting
    // it with two left meant a slow response still arrived after the queue had
    // run out. One extra song is roughly three more minutes to answer in.
    if (!queue.length || index == null || queue.length - index > 3) {
      return;
    }
    const seed =
      sourceTrackFor(queue[index]) ?? queueSource[queueSource.length - 1];
    if (!seed) {
      return;
    }
    // getDownloadKey, not getTrackId: the ISRC is part of getTrackId, and a
    // radio pick arrives unenriched while the same song already in the queue
    // came from a catalogue lookup WITH one. Two ids for one song is a dedupe
    // that passes everything through.
    const seen = new Set(queueSource.map(getDownloadKey));
    const picks: Track[] = (
      await getRadio(cleanText(seed.title), cleanText(seed.artist))
    )
      .map(raw => normalizeTrack(raw))
      .filter(
        (t): t is Track =>
          !!t && isPlayableTrack(t) && !seen.has(getDownloadKey(t)),
      )
      .slice(0, 8)
      .map(t => ({...t, _autoplay: true}));
    const items = picks
      .map(t => ({t, q: toQueueItem(t, currentQuality())}))
      .filter(x => x.q !== null);
    if (items.length) {
      // Only the append is serialised — the radio fetch above is a network
      // call, and a drag's move must not queue up behind it.
      await serialQueueOp(async () => {
        await TrackPlayer.add(items.map(x => x.q!));
        queueSource = [...queueSource, ...items.map(x => x.t)];
      });
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

async function prefetchNext(position: number, idx: number): Promise<void> {
  try {
    if (position < 3) {
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

let fadeTimer: ReturnType<typeof setInterval> | null = null;
/** Whether the previous watcher tick saw audio running — see the idle gate. */
let wasPlaying = false;
/** The span last handed to the native crossfade scheduler, in ms. */
let pushedSpan = -1;

/**
 * Tell the native scheduler how long to fade — zero while the sleep timer's
 * end-of-track stop is armed, because a crossfade starts the NEXT song
 * seconds before the boundary, mixing a song nobody asked for into the last
 * seconds of the one they meant to fall asleep to.
 */
function pushCrossfade(seconds: number): void {
  const span = sleepMode() === 'endOfTrack' ? 0 : Math.max(0, seconds) * 1000;
  if (span !== pushedSpan) {
    pushedSpan = span;
    setCrossfade(span);
  }
}

/**
 * Tear down a running crossfade — for a manual skip, pause or fresh play,
 * where the user is choosing what plays rather than letting the queue flow
 * into it. Restores full volume so the chosen track isn't left quiet.
 */
export function cancelCrossfade(): void {
  endCrossfade();
  // ALWAYS restore full volume, natively — a fade-down that was cut short must
  // not leave the engine stuck quiet.
  restorePlayerVolume();
  TrackPlayer.setVolume(1).catch(() => {});
}

export function startCrossfadeWatcher(getSeconds: () => number): void {
  if (fadeTimer) {
    return;
  }
  pushCrossfade(getSeconds());
  fadeTimer = setInterval(async () => {
    // ── The idle gate ─────────────────────────────────────────────────────
    //
    // Nothing below this point means anything when no audio is running, and
    // this timer is started at boot and never cleared — so without the gate it
    // was the most expensive thing in the app by a wide margin.
    //
    // Every tick, once a second, for the whole life of the process (which is
    // DAYS: the mediaPlayback foreground service keeps it resident long after
    // the last song), it ran topUpFromRadio (getQueue — marshalling the entire
    // queue across the bridge), prefetchNext (getProgress +
    // getActiveTrackIndex), then getProgress + getActiveTrackIndex +
    // getActiveTrack again. Seven bridge round trips a second, one of them
    // O(queue length), while the user was reading a book with the app closed.
    //
    // One cheap state read replaces all of it. Paused, stopped or idle, the
    // tick now costs a single call and returns; playing, nothing changes.
    let playing = false;
    try {
      const {state} = await TrackPlayer.getPlaybackState();
      playing =
        state === State.Playing ||
        state === State.Buffering ||
        state === State.Loading;
    } catch {
      return; // engine not up — there is nothing to do either way
    }
    if (!playing) {
      // The falling edge is the one tick that still has work: a pause must
      // record the position it actually stopped at. Under the old always-on
      // tick that happened by accident, on whichever tick next passed
      // saveResume's 4s throttle; forcing it here writes the exact position
      // once and then goes quiet, which is both more accurate and one write
      // instead of a tick a second forever.
      if (wasPlaying) {
        wasPlaying = false;
        try {
          const {position} = await TrackPlayer.getProgress();
          const idx = (await TrackPlayer.getActiveTrackIndex()) ?? 0;
          const src = sourceTrackFor(
            (await TrackPlayer.getActiveTrack()) ?? null,
          );
          if (src) {
            saveResume(
              {track: src, position, queue: queueSource, index: idx},
              true,
            );
          }
        } catch {}
      }
      return;
    }
    wasPlaying = true;
    // Foreground only, like this whole tick — which is fine: the setting and
    // the sleep timer are both changed from the UI, so the app is open.
    pushCrossfade(getSeconds());

    // Piggybacked on this tick: keep the queue topped up with similar songs.
    //
    // Gated on the MIRROR first. topUpFromRadio's first act is getQueue(),
    // which marshals every track across the bridge — once a second, for a
    // 200-song playlist, only to find there was plenty left. The mirror is
    // refreshed on every queue change and track settle, so it is a sound
    // "definitely not yet"; when it says "maybe", the real check runs. The
    // track-change event and the service backstop still call it ungated.
    if (engineQueue.length - activeIndex <= 3) {
      topUpFromRadio().catch(() => {});
    }

    // One progress/index read for the rest of the tick. It used to be two of
    // each: prefetchNext read them, then the resume save read them again.
    let position = 0;
    let idx = 0;
    try {
      const [p, i] = await Promise.all([
        TrackPlayer.getProgress(),
        TrackPlayer.getActiveTrackIndex(),
      ]);
      position = p.position;
      idx = i ?? 0;
    } catch {
      return;
    }

    // …and warm the NEXT track's stream a few seconds in, so pressing skip (or
    // an auto-advance) plays instantly instead of resolving the source cold.
    // getStreamInfo caches exactly what proxy_stream reuses a beat later.
    prefetchNext(position, idx).catch(() => {});

    // …and remember the current position, throttled inside saveResume, so a
    // reopen resumes at the timestamp you left rather than the song's start.
    try {
      const src = sourceTrackFor((await TrackPlayer.getActiveTrack()) ?? null);
      if (src) {
        saveResume({track: src, position, queue: queueSource, index: idx});
      }
    } catch {}
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
export {usePlaybackState} from 'react-native-track-player';

function onAppState(cb: () => void) {
  const sub = AppState.addEventListener('change', cb);
  return () => sub.remove();
}

/**
 * useProgress, parked while the app is in the background. Nothing on screen
 * reads a position then, and every caller (the mini player's hairline, the
 * full player's bar) otherwise kept asking the engine through a whole
 * screen-off listening session. Back in the foreground the interval changes
 * back, which restarts the poll with an immediate read.
 */
export function useProgress(interval: number) {
  const background = useSyncExternalStore(
    onAppState,
    () => AppState.currentState === 'background',
  );
  return useProgressPolled(background ? 3600000 : interval);
}
