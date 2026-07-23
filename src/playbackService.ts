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
import TrackPlayer, {Event} from 'react-native-track-player';

module.exports = async function playbackService() {
  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.reset());
  TrackPlayer.addEventListener(Event.RemoteSeek, ({position}) =>
    TrackPlayer.seekTo(position),
  );

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

  // Pause on unplug/disconnect rather than blasting audio out of the speaker.
  TrackPlayer.addEventListener(Event.RemoteDuck, async ({paused, permanent}) => {
    if (permanent) {
      await TrackPlayer.pause();
      return;
    }
    if (paused) {
      await TrackPlayer.pause();
    } else {
      await TrackPlayer.play();
    }
  });
};
