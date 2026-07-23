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
import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  Event,
  RepeatMode,
  State,
} from 'react-native-track-player';
import {apiUrl, type Track} from './backend';
import {currentQuality} from './store';

let ready = false;
let available: boolean | null = null;

/** Build the streaming URL. proxy_stream handles range requests + the bitrate
 *  ladder, and apiUrl attaches the API token the backend requires. */
export function streamUrlFor(
  track: Track,
  bitrate = currentQuality(),
): string | null {
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
      ],
      progressUpdateEventInterval: 1,
    });
    await TrackPlayer.setRepeatMode(RepeatMode.Off);
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

  await TrackPlayer.reset();
  await TrackPlayer.add(items.map(x => x.q));
  if (startAt > 0) {
    await TrackPlayer.skip(startAt);
  }
  await TrackPlayer.play();
}

export async function skipNext(): Promise<void> {
  try {
    await TrackPlayer.skipToNext();
  } catch {
    /* end of queue */
  }
}

/** Restart the track first; only jump back when already near the start — the
 *  behaviour every other player has, so one stray tap can't lose your place. */
export async function skipPrevious(): Promise<void> {
  try {
    const pos = await TrackPlayer.getPosition();
    if (pos > 3) {
      await TrackPlayer.seekTo(0);
      return;
    }
    await TrackPlayer.skipToPrevious();
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
    await TrackPlayer.pause();
  } else {
    await TrackPlayer.play();
  }
}

export async function stop(): Promise<void> {
  try {
    await TrackPlayer.reset();
  } catch {
    /* engine not up — nothing to stop */
  }
}

export async function seekTo(seconds: number): Promise<void> {
  await TrackPlayer.seekTo(seconds);
}

export {TrackPlayer, State, Event, RepeatMode};
