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
import {useEffect, useState} from 'react';
import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  Event,
  RepeatMode,
  State,
  usePlaybackState,
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
} from './audioEffects';
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
      const src = sourceTrackFor(e.track ?? null);
      if (src) {
        remember(src);
      }
      // Save the session on every track change (forced past the throttle), so a
      // reopen lands on the right song even if the app was killed mid-track.
      try {
        const idx = (await TrackPlayer.getActiveTrackIndex()) ?? 0;
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
        fadeInIfNeeded();
      }
      // Effects die with the audio session; re-attach for the new one.
      applyAudioEffects();
    });

    ready = true;
    available = true;
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
    await TrackPlayer.reset();
    await TrackPlayer.add(items.map(x => x.q!));
    const idx = Math.max(0, Math.min(items.length - 1, s.index));
    if (idx > 0) {
      await TrackPlayer.skip(idx);
    }
    if (s.position > 0) {
      await TrackPlayer.seekTo(s.position);
    }
    // Left paused — see above.
    applyAudioEffects();
    return true;
  } catch {
    return false;
  }
}

/** Shape a backend Track for the audio engine. Returns null if unplayable. */
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

  await TrackPlayer.reset();
  await TrackPlayer.add(items.map(x => x.q));
  if (startAt > 0) {
    await TrackPlayer.skip(startAt);
  }
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
  // A song the user queues goes BEFORE the autoplay-radio tail — "add to
  // queue" means "play this soon", not "after eight songs you didn't pick".
  // The position comes from the ENGINE's queue (the truth), since the JS-side
  // pool can drift after manual reorders.
  const queue = await TrackPlayer.getQueue();
  const firstAuto = queue.findIndex(it => sourceTrackFor(it)?._autoplay);
  if (firstAuto >= 0) {
    await TrackPlayer.add([item], firstAuto);
  } else {
    await TrackPlayer.add([item]);
  }
  queueSource = [...queueSource, track];
}

/** Skips always resume playback: changing song while paused and getting
 *  silence reads as the skip having failed. */
export async function skipNext(): Promise<void> {
  cancelCrossfade(); // a manual skip isn't a crossfade — kill any overlap
  try {
    await TrackPlayer.skipToNext();
    await TrackPlayer.play();
  } catch {
    /* end of queue */
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
    await TrackPlayer.skipToPrevious();
    await TrackPlayer.play();
  } catch {
    await TrackPlayer.seekTo(0);
  }
}

/** Shuffle everything after the current track, leaving what's playing alone. */
export async function shuffleQueue(): Promise<void> {
  const queue = await TrackPlayer.getQueue();
  const index = await TrackPlayer.getActiveTrackIndex();
  if (queue.length < 3 || index == null) {
    return;
  }
  const rest = queue.slice(index + 1);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  await TrackPlayer.removeUpcomingTracks();
  await TrackPlayer.add(rest);
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
export async function togglePlay(): Promise<void> {
  const {state} = await TrackPlayer.getPlaybackState();
  const active =
    state === State.Playing ||
    state === State.Buffering ||
    state === State.Loading;
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
  const seed = sourceTrackFor(queue[index]) ?? queueSource[queueSource.length - 1];
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
      .filter((t): t is Track => !!t && isPlayableTrack(t) && !seen.has(getTrackId(t)))
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
let didFadeOut = false; // the last advance faded down — so fade the next one UP
// Bumped whenever a new fade starts. Any in-flight ramp checks this and bails
// the instant a newer one begins, so the outgoing fade-down and the incoming
// fade-up can never fight over setVolume (which left the next song stuck quiet).
let fadeGen = 0;
// True while the native overlap player is running toward a handoff — a REAL
// crossfade (two songs audible at once) rather than the fade-down/up fallback.
let cfActive = false;
let getCrossfadeSeconds: () => number = () => 0;

/**
 * Tear down a running crossfade WITHOUT the handoff seek — for a manual skip or
 * stop, where the user is choosing the next track rather than letting the queue
 * flow into it. Restores full volume so the chosen track isn't left quiet.
 */
function cancelCrossfade(): void {
  if (!cfActive) {
    return;
  }
  cfActive = false;
  didFadeOut = false;
  fadeGen++; // abort any in-flight RNTP ramp
  endCrossfade();
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
  fadeGen++; // no stray RNTP ramp during the handoff
  try {
    const pos = await crossfadePosition();
    if (pos > 0.5) {
      await TrackPlayer.seekTo(pos);
      // Give RNTP a beat to buffer at pos while the overlap still covers sound.
      await new Promise(r => setTimeout(r, 250));
    }
  } catch {}
  try {
    await TrackPlayer.setVolume(1);
  } catch {}
  await endCrossfade();
}

/** Current crossfade span; readable outside the watcher (the fade-in half). */
function crossfadeSpanRef(): number {
  return getCrossfadeSeconds();
}

/**
 * Fade the incoming track up from quiet — the OTHER half of the transition,
 * run on track change. Only when the outgoing track actually faded out (a
 * natural end under crossfade); a manual skip must NOT get an unwanted fade.
 */
async function fadeInIfNeeded(): Promise<void> {
  if (!didFadeOut) {
    // Make sure volume is full for a normal advance.
    try {
      await TrackPlayer.setVolume(1);
    } catch {}
    return;
  }
  didFadeOut = false;
  const gen = ++fadeGen;
  const seconds = Math.min(crossfadeSpanRef(), 3) || 2;
  const steps = 12;
  try {
    await TrackPlayer.setVolume(0);
    for (let i = 1; i <= steps; i++) {
      if (gen !== fadeGen) {
        return; // a newer fade took over — stop ramping
      }
      await TrackPlayer.setVolume(i / steps);
      await new Promise(r => setTimeout(r, (seconds * 1000) / steps));
    }
    if (gen === fadeGen) {
      await TrackPlayer.setVolume(1);
    }
  } catch {
    try {
      await TrackPlayer.setVolume(1);
    } catch {}
  }
}

export function startCrossfadeWatcher(getSeconds: () => number): void {
  getCrossfadeSeconds = getSeconds;
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
    if (span <= 0) {
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
        // Ramp the outgoing track DOWN over its final `span` seconds. Do NOT
        // restore volume here — that was the bug: the song jumped back to full
        // volume right before ending, so the fade was inaudible. The incoming
        // track is faded back up by fadeInIfNeeded() on the track change.
        didFadeOut = true;

        // Real crossfade: start the SECOND stream on the incoming track, rising,
        // so it overlaps this fade-down. Only if the build supports it and the
        // next track's stream URL is known; otherwise this degrades to the plain
        // fade-down/up handled by fadeInIfNeeded on the track change.
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

        const gen = ++fadeGen;
        const steps = 12;
        for (let i = 1; i <= steps; i++) {
          if (gen !== fadeGen) {
            break; // the track changed and fade-in took over
          }
          await TrackPlayer.setVolume(Math.max(0.04, 1 - i / steps));
          await new Promise(r => setTimeout(r, (span * 1000) / steps));
        }
      } else if (remaining > span + 1 && fadedFor === key) {
        // Seeked backwards out of the fade zone — cancel it and go back to full.
        fadedFor = '';
        didFadeOut = false;
        fadeGen++; // abort any in-flight fade-down
        cancelCrossfade(); // and drop any overlap that had started
        try {
          await TrackPlayer.setVolume(1);
        } catch {}
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
export {useActiveTrack, usePlaybackState, useProgress} from 'react-native-track-player';
