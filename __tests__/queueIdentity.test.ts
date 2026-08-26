/**
 * Two bugs that produced one screenshot: a queue with five copies of the same
 * song in it, rows lifting in groups when one was dragged, and a track dropped
 * second playing much later.
 *
 * 1. Every queue item carried `id: title-artist`, so duplicates of a song were
 *    indistinguishable to the list. DraggableFlatList tracks the lifted cell BY
 *    KEY and VirtualizedList registers cells by key, so duplicate keys collapse
 *    rows together and hand back the wrong drop index.
 * 2. topUpFromRadio claimed its re-entrancy flag AFTER an await, so the track
 *    change event and the crossfade watcher could both pass the guard and both
 *    append a batch of radio picks — deduped against the same pre-append
 *    snapshot, which is how the duplicates got there in the first place.
 */
import {expect, jest, test} from '@jest/globals';
import TrackPlayer from 'react-native-track-player';
import {addToQueue, playTrack, topUpFromRadio} from '../src/player';

jest.mock('react-native-track-player', () => {
  const queue: any[] = [];
  let active = 0;
  return {
    __esModule: true,
    default: {
      __queue: queue,
      __active: () => active,
      setupPlayer: async () => undefined,
      updateOptions: async () => undefined,
      setRepeatMode: async () => undefined,
      getRepeatMode: async () => 0,
      addEventListener: () => undefined,
      reset: async () => {
        queue.length = 0;
        active = 0;
      },
      add: async (items: any[], at?: number) => {
        if (typeof at === 'number') {
          queue.splice(at, 0, ...items);
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

/** One song, offered eight times over — what a radio call actually returns for
 *  a seed whose station is thin. The dedupe is what stops it landing twice. */
const mockRadio = Array.from({length: 8}, (_, i) => ({
  title: `Radio ${i}`,
  artist: 'Station',
  playable_source: 'jiosaavn',
  sources: {jiosaavn: {url: `https://cdn/r${i}.mp3`}},
}));

jest.mock('../src/backend', () => ({
  apiUrl: (p: string) => `http://127.0.0.1:8765${p}`,
  getStreamInfo: async () => ({}),
  // Slow on purpose: the overlap between two callers is exactly the window the
  // old guard left open.
  getRadio: async () => {
    await new Promise(r => setTimeout(r, 20));
    return mockRadio;
  },
}));
jest.mock('../src/store', () => ({
  currentQuality: () => 320,
  readSettings: () => ({autoplay: true, crossfadeDuration: 0}),
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

const engine = TrackPlayer as unknown as {__queue: any[]};

const song = (n: string) =>
  ({
    title: n,
    artist: 'Someone',
    playable_source: 'jiosaavn',
    sources: {jiosaavn: {url: `https://cdn/${n}.mp3`}},
  } as any);

test('the same song queued three times gets three distinct row ids', async () => {
  const twice = song('Repeat');
  await playTrack(song('First'));
  await addToQueue(twice);
  await addToQueue(twice);
  await addToQueue(twice);

  const rows = engine.__queue;
  expect(rows).toHaveLength(4);

  // The SONG id is deliberately the same for all three — that is what "is this
  // the same song" means, and likes and radio dedupe depend on it.
  const copies = rows.filter(t => t.title === 'Repeat');
  expect(new Set(copies.map(t => t.id)).size).toBe(1);

  // The ROW id is not. This is the assertion that fails without _qid, and its
  // failure is what let three rows think they were the one being dragged.
  const qids = rows.map(t => t._qid);
  expect(qids.every(Boolean)).toBe(true);
  expect(new Set(qids).size).toBe(rows.length);
});

test('two radio top-ups racing append one batch, not two', async () => {
  await playTrack(song('Seed'));
  const before = engine.__queue.length;

  // The real pair: the PlaybackActiveTrackChanged handler and the crossfade
  // watcher's tick, a skip apart. Neither awaits the other.
  await Promise.all([topUpFromRadio(), topUpFromRadio()]);

  const added = engine.__queue.length - before;
  expect(added).toBe(mockRadio.length);

  const titles = engine.__queue.map(t => t.title);
  expect(new Set(titles).size).toBe(titles.length);
});
