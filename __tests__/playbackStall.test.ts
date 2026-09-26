/**
 * A stream that stops delivering leaves the engine in Buffering with no error:
 * the song goes silent with the pause icon still up. kickIfStalled is the
 * recovery. It must wait out a normal rebuffer, then seek just past the empty
 * buffer (a same-position seek is served from the buffer and changes nothing),
 * never past the end of the song, and try again if the stall outlasts a kick.
 */
import {expect, jest, test} from '@jest/globals';
import TrackPlayer from 'react-native-track-player';
import {logEvent} from '../src/analytics';
import {kickIfStalled} from '../src/player';

jest.mock('react-native-track-player', () => ({
  __esModule: true,
  default: {
    seekTo: jest.fn(async () => undefined),
    getActiveTrack: jest.fn(async () => null),
  },
  State: {},
  Event: {},
  Capability: {},
  RepeatMode: {},
  AppKilledPlaybackBehavior: {},
  usePlaybackState: () => ({}),
  useProgress: () => ({position: 0, duration: 0}),
}));
jest.mock('../src/analytics', () => ({logEvent: jest.fn(), songParams: () => ({})}));
jest.mock('../src/backend', () => ({apiUrl: (p: string) => p, getStreamInfo: async () => ({}), getRadio: async () => []}));
jest.mock('../src/store', () => ({currentQuality: () => 320, readSettings: () => ({})}));
jest.mock('../src/audioEffects', () => ({}));
jest.mock('../src/duckState', () => ({setPausedByDuck: () => undefined}));
jest.mock('../src/sleepTimer', () => ({sleepMode: () => 'off'}));
jest.mock('../src/recentlyPlayed', () => ({remember: () => undefined}));
jest.mock('../src/resume', () => ({}));

test('waits out a normal rebuffer, then seeks past the buffer and re-arms', async () => {
  const seek = TrackPlayer.seekTo as unknown as jest.Mock;
  const now = jest.spyOn(Date, 'now');
  const at = (ms: number, pos: number, dur = 200) => {
    now.mockReturnValue(ms);
    kickIfStalled(pos, dur);
  };

  at(1_000, 42); // stall starts
  at(9_000, 42); // 8s: still a plausible rebuffer
  expect(seek).not.toHaveBeenCalled();

  at(11_000, 42); // 10s: kick
  expect(seek).toHaveBeenLastCalledWith(43);
  await Promise.resolve();
  expect(logEvent).toHaveBeenCalledWith('playback_stall', {position: 42});

  at(15_000, 43); // just kicked: give the fresh request time
  expect(seek).toHaveBeenCalledTimes(1);

  at(21_000, 199.5); // still stuck 10s later: kick again, clamped short of the end
  expect(seek).toHaveBeenCalledTimes(2);
  expect(seek).toHaveBeenLastCalledWith(199);
});
