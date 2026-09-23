/**
 * "The music engine stopped" must not appear during a healthy cold start.
 *
 * The old probe sent ONE /health and treated a single unanswered request as
 * death. On a cold launch that request is competing with Chaquopy extracting
 * the stdlib and Werkzeug serving several warm-up calls at once, so it can
 * fail while the backend is perfectly alive — which is exactly the report:
 * the notice appears, and the app then works.
 *
 * This is the kind of fix that silently regresses. Someone reads
 * `warnIfEngineStopped` a year from now, sees a poll where a probe would do,
 * and simplifies it back. These two cases are the reason it is a poll.
 */
import {afterEach, beforeEach, expect, jest, test} from '@jest/globals';

jest.mock('react-native', () => ({NativeModules: {}}));

/**
 * `mock`-prefixed, because that is the one name a jest.mock factory is allowed
 * to close over — and forwarded through an arrow rather than handed over
 * directly, because ES imports hoist ABOVE this `const`. A factory that reads
 * `mockToast` at module-load time captures `undefined`; one that reads it at
 * CALL time gets the spy.
 */
const mockToast = jest.fn();
jest.mock('../src/toast', () => ({
  toast: (...args: unknown[]) => mockToast(...args),
}));

// NB: this import must stay below the mocks above — jest hoists jest.mock().
import {apiGet} from '../src/backend';

type Fetch = (input: unknown) => Promise<{ok: boolean; json: () => unknown}>;
const ok = () => ({ok: true, json: () => ({})});

beforeEach(() => {
  jest.useFakeTimers();
  mockToast.mockClear();
});
afterEach(() => {
  jest.useRealTimers();
});

/**
 * Run the retry's whole backoff without waiting in real time.
 *
 * `warnIfEngineStopped` is fired and NOT awaited by apiGet, so the assertion
 * has to outlive the promise it came from. The *Async* variant is what makes
 * this work: it drains microtasks between timers, and every step of the
 * backoff lands several awaits deep.
 */
async function drain(promise: Promise<unknown>) {
  await promise.catch(() => {});
  await jest.advanceTimersByTimeAsync(6000);
}

test('a backend that is merely slow to answer /health says nothing', async () => {
  let healthCalls = 0;
  const fetchMock: Fetch = async input => {
    const url = String(input);
    if (url.includes('/health')) {
      // Down for the first probe, up for the second — a booting backend.
      if (++healthCalls === 1) {
        throw new Error('ECONNREFUSED');
      }
      return ok();
    }
    throw new Error('ECONNREFUSED'); // the API call that started all this
  };
  (globalThis as {fetch?: unknown}).fetch = fetchMock;

  await drain(apiGet('/home'));

  expect(healthCalls).toBeGreaterThan(1);
  expect(mockToast).not.toHaveBeenCalled();
});

test('a backend that never answers at all does warn', async () => {
  (globalThis as {fetch?: unknown}).fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as Fetch;

  await drain(apiGet('/home'));

  expect(mockToast).toHaveBeenCalledWith(
    expect.stringContaining('music engine stopped'),
  );
});
