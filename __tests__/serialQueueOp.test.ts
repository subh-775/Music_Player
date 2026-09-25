/**
 * Queue mutations run one at a time, in the order they were asked for.
 *
 * A reorder is several awaited bridge calls (read, remove, add, refresh). Two
 * of them interleaving — a second drop landing between another's remove and
 * add — read a queue one item short and moved the wrong track. This pins the
 * one property the fix rests on, including when a step in the chain fails.
 */
import {expect, jest, test} from '@jest/globals';

jest.mock('react-native', () => ({Image: {prefetch: async () => true}}));
jest.mock('react-native-track-player', () => ({
  __esModule: true,
  default: {},
  AppKilledPlaybackBehavior: {},
  Capability: {},
  Event: {},
  RepeatMode: {},
  State: {},
  usePlaybackState: () => ({}),
  useProgress: () => ({position: 0, duration: 0}),
}));
jest.mock('../src/backend', () => ({}));
jest.mock('../src/store', () => ({}));
jest.mock('../src/audioEffects', () => ({}));
jest.mock('../src/artworkColor', () => ({}));
jest.mock('../src/recentlyPlayed', () => ({}));
jest.mock('../src/resume', () => ({}));
jest.mock('../src/sleepTimer', () => ({}));
jest.mock('../src/duckState', () => ({}));
jest.mock('../src/tracks', () => ({}));

// NB: below the mocks — jest hoists jest.mock().
import {serialQueueOp} from '../src/player';

const tick = () => new Promise(r => setTimeout(r, 0));

test('operations never overlap, and finish in call order', async () => {
  const log: string[] = [];
  const op = (name: string, steps: number) => async () => {
    log.push(`${name}:start`);
    for (let i = 0; i < steps; i++) {
      await tick();
    }
    log.push(`${name}:end`);
    return name;
  };
  // The slow one first: without the chain, "b" would start (and finish)
  // while "a" is still mid-flight.
  const results = await Promise.all([
    serialQueueOp(op('a', 5)),
    serialQueueOp(op('b', 1)),
    serialQueueOp(op('c', 2)),
  ]);
  expect(results).toEqual(['a', 'b', 'c']);
  expect(log).toEqual([
    'a:start',
    'a:end',
    'b:start',
    'b:end',
    'c:start',
    'c:end',
  ]);
});

test('a failed operation rejects for its caller but does not stop the next', async () => {
  const failing = serialQueueOp(async () => {
    throw new Error('engine said no');
  });
  const after = serialQueueOp(async () => 'ran');
  await expect(failing).rejects.toThrow('engine said no');
  await expect(after).resolves.toBe('ran');
});
