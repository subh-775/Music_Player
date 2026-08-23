/**
 * Runs outside the UI, in the playback foreground service.
 *
 * This is where lock-screen buttons, the notification transport, and Bluetooth /
 * earbud (AVRCP) commands land. Handling them here — rather than in a component
 * — is what makes them work while the app is backgrounded or the screen is off.
 *
 * Deliberately device-agnostic: we respond to the standard remote events every
 * headset and car stereo emits, with no per-device mapping.
 */
import TrackPlayer, {Event, State} from 'react-native-track-player';
import {setPausedByDuck, wasPausedByDuck} from './duckState';
import {topUpFromRadio} from './player';

/**
 * Did WE pause because we lost audio focus, or did the user?
 *
 * Without this distinction the duck handler resumed on ANY focus regain — so a
 * notification chime arriving after you had deliberately pressed pause started
 * the music back up on its own. Only playback that ducking interrupted may be
 * resumed by ducking ending; anything the user paused stays paused.
 *
 * This mirrors what the reference build got for free: there, Chromium owned
 * audio focus and only ever resumed the media element it had paused itself.
 */
module.exports = async function playbackService() {
  // An explicit transport command settles who owns the pause: whatever the user
  // (or their headset) just asked for outranks anything ducking remembered.
  TrackPlayer.addEventListener(Event.RemotePlay, () => {
    setPausedByDuck(false);
    TrackPlayer.play();
  });
  TrackPlayer.addEventListener(Event.RemotePause, () => {
    setPausedByDuck(false);
    TrackPlayer.pause();
  });
  TrackPlayer.addEventListener(Event.RemoteStop, () => {
    setPausedByDuck(false);
    TrackPlayer.reset();
  });
  TrackPlayer.addEventListener(Event.RemoteSeek, ({position}) =>
    TrackPlayer.seekTo(position),
  );

  /**
   * The queue ran dry — last line of defence for autoplay.
   *
   * The top-up normally happens on PlaybackActiveTrackChanged, a few songs
   * ahead. If that missed (a slow radio response, a queue emptied by a manual
   * skip), this catches it: it runs HERE, in the foreground service, so it
   * still fires with the app backgrounded and the screen off — which is the
   * exact situation where the UI's JS timer is frozen and playback used to just
   * stop until you pressed next.
   */
  TrackPlayer.addEventListener(Event.PlaybackQueueEnded, async () => {
    try {
      await topUpFromRadio();
      const queue = await TrackPlayer.getQueue();
      const index = await TrackPlayer.getActiveTrackIndex();
      // Only if the top-up actually appended something past where we stopped.
      if (queue.length && index != null && index < queue.length - 1) {
        await TrackPlayer.skipToNext();
        await TrackPlayer.play();
      }
    } catch {
      /* nothing to continue with — leave playback stopped */
    }
  });

  TrackPlayer.addEventListener(Event.RemoteNext, async () => {
    try {
      await TrackPlayer.skipToNext();
    } catch {
      /* end of queue — nothing to skip to */
    }
  });

  // A headset's "previous" restarts the track first, and only jumps back when
  // pressed near the start. That is the behaviour every other player has, and
  // it stops one stray double-tap from losing your place.
  TrackPlayer.addEventListener(Event.RemotePrevious, async () => {
    try {
      const position = await TrackPlayer.getPosition();
      if (position > 3) {
        await TrackPlayer.seekTo(0);
      } else {
        await TrackPlayer.skipToPrevious();
      }
    } catch {
      await TrackPlayer.seekTo(0);
    }
  });

  // Audio focus changed — a call, another player, a notification chime.
  TrackPlayer.addEventListener(
    Event.RemoteDuck,
    async ({paused, permanent}) => {
      if (permanent) {
        // Focus is gone for good (another app took over). Never auto-resume.
        setPausedByDuck(false);
        await TrackPlayer.pause();
        return;
      }
      if (paused) {
        // Transient loss. Only remember it as ours if we were actually playing —
        // otherwise a duck arriving while already paused would later "resume"
        // music the user had stopped.
        const {state} = await TrackPlayer.getPlaybackState();
        const wasPlaying =
          state === State.Playing ||
          state === State.Buffering ||
          state === State.Loading;
        if (wasPlaying) {
          setPausedByDuck(true);
          await TrackPlayer.pause();
        }
        return;
      }
      // Focus regained: resume ONLY what ducking paused.
      if (wasPausedByDuck()) {
        setPausedByDuck(false);
        await TrackPlayer.play();
      }
    },
  );
};
