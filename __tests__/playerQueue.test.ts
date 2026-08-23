/**
 * playTrack now starts the song on a ONE-track queue and fills the rest in
 * behind it, so the wait to hear something no longer scales with the length of
 * the playlist you tapped from.
 *
 * That reordering is the one change in this release that could put the wrong
 * song on: if the appends and the prepend land in the wrong order, "next" plays
 * something you never chose. This drives the real playTrack against a fake
 * engine and asserts the queue it ends up with is the list, in order, with the
 * tapped track active.
 */
// Imported explicitly rather than taken from the global, so this file
// typechecks without pulling in @types/jest.
import {expect, jest, test} from '@jest/globals';
import TrackPlayer from 'react-native-track-player';
import {playTrack} from '../src/player';

jest.mock('react-native-track-player', () => {
  const queue: any[] = [];
  let active = 0;
  const listeners: any[] = [];
  return {
    __esModule: true,
    default: {
      __queue: queue,
      __active: () => active,
      setupPlayer: async () => undefined,
      updateOptions: async () => undefined,
      setRepeatMode: async () => undefined,
      getRepeatMode: async () => 0,
      addEventListener: (_e: any, cb: any) => listeners.push(cb),
      reset: async () => {
        queue.length = 0;
        active = 0;
      },
      add: async (items: any[], at?: number) => {
        if (typeof at === 'number') {
          queue.splice(at, 0, ...items);
          // ExoPlayer keeps playing the current item; its index shifts by
          // however many were inserted before it.
          if (at <= active) {
            active += items.length;
          }
        } else {
          queue.push(...items);
        }
      },
      remove: async () => undefined,
      removeUpcomingTracks: async () => undefined,
      play: async () => undefined,
      pause: async () => undefined,
      seekTo: async () => undefined,
      setVolume: async () => undefined,
      getQueue: async () => [...queue],
      getActiveTrackIndex: async () => active,
      getActiveTrack: async () => queue[active] ?? null,
      getProgress: async () => ({position: 0, duration: 0}),
      getPlaybackState: async () => ({state: 'playing'}),
    },
    AppKilledPlaybackBehavior: {StopPlaybackAndRemoveNotification: 0},
    Capability: {
      Play: 0,
      Pause: 1,
      SkipToNext: 2,
      SkipToPrevious: 3,
      SeekTo: 4,
      Stop: 5,
    },
    Event: {PlaybackActiveTrackChanged: 'x'},
    RepeatMode: {Off: 0, Track: 1, Queue: 2},
    State: {Playing: 'playing', Ready: 'ready'},
    usePlaybackState: () => ({state: 'playing'}),
    useProgress: () => ({position: 0, duration: 0}),
  };
});

// Everything playTrack reaches for that needs a device or a backend.
jest.mock('../src/backend', () => ({
  apiUrl: (p: string) => `http://127.0.0.1:8765${p}`,
  getStreamInfo: async () => ({}),
  getRadio: async () => [],
}));
jest.mock('../src/store', () => ({
  currentQuality: () => 320,
  readSettings: () => ({autoplay: false, crossfadeDuration: 0}),
}));
jest.mock('../src/audioEffects', () => ({
  applyAudioEffects: () => undefined,
  beginCrossfade: async () => false,
  crossfadePosition: async () => 0,
  crossfadeSupported: false,
  endCrossfade: () => undefined,
  fadeInPlayer: () => undefined,
  fadeOutPlayer: () => undefined,
  restorePlayerVolume: () => undefined,
}));
jest.mock('../src/duckState', () => ({setPausedByDuck: () => undefined}));
jest.mock('../src/sleepTimer', () => ({
  sleepTimerOnTrackChange: () => undefined,
}));
jest.mock('../src/recentlyPlayed', () => ({remember: () => undefined}));
jest.mock('../src/resume', () => ({
  clearResume: () => undefined,
  readResume: async () => null,
  saveResume: () => undefined,
}));

const engine = TrackPlayer as unknown as {
  __queue: any[];
  __active: () => number;
};

const album = Array.from({length: 6}, (_, i) => ({
  title: `Song ${i}`,
  artist: 'Someone',
  playable_source: 'jiosaavn',
  sources: {jiosaavn: {url: `https://cdn/${i}.mp3`}},
})) as any[];

const titles = () => engine.__queue.map(t => t.title);

test('tapping a track mid-album leaves the whole album queued, in order', async () => {
  await playTrack(album[3], album);
  expect(titles()).toEqual([
    'Song 0',
    'Song 1',
    'Song 2',
    'Song 3',
    'Song 4',
    'Song 5',
  ]);
  // The tapped song is the one playing — not track 0, and not track 4.
  expect(engine.__active()).toBe(3);
});

test('tapping the first track needs no prepend', async () => {
  await playTrack(album[0], album);
  expect(titles()).toEqual([
    'Song 0',
    'Song 1',
    'Song 2',
    'Song 3',
    'Song 4',
    'Song 5',
  ]);
  expect(engine.__active()).toBe(0);
});

test('tapping the last track leaves nothing to append', async () => {
  await playTrack(album[5], album);
  expect(titles()).toEqual([
    'Song 0',
    'Song 1',
    'Song 2',
    'Song 3',
    'Song 4',
    'Song 5',
  ]);
  expect(engine.__active()).toBe(5);
});

test('a single track plays on its own', async () => {
  await playTrack(album[2]);
  expect(titles()).toEqual(['Song 2']);
  expect(engine.__active()).toBe(0);
});
