/**
 * The persistence primitive every store in the app is built from.
 *
 * One module-level cache + subscribe/snapshot pair per key, so state survives a
 * screen unmounting and every screen sees the same value. Reads come from
 * memory (the UI never waits on disk); writes are mirrored to AsyncStorage
 * best-effort.
 *
 * This exists because likes, playlists, pins, settings and search history are
 * the same problem five times, and five hand-rolled copies is five places for
 * them to drift.
 */
import {useSyncExternalStore} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Store<T> = {
  get(): T;
  set(value: T): void;
  /** Read-modify-write in one step, so callers can't lose a concurrent update. */
  update(fn: (current: T) => T): void;
  subscribe(listener: () => void): () => void;
  /** Load from disk. Safe to call more than once; only the first does work. */
  hydrate(): Promise<void>;
  /** Seed from an already-read raw string (the batched boot path). */
  hydrateFrom(raw: string | null): void;
  /** Write any debounced value out now. For backgrounding/teardown. */
  flush(): void;
};

/** Every store built here, so one call at startup can load all of them. This
 *  is also why no store needs to import any other one just to be hydrated. */
// Keyed by storage key so hydrateAll can hand each store back the raw string
// multiGet read for it. `any` because the map is heterogeneous by nature —
// every store has a different T and only the key-agnostic methods are used.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry = new Map<string, Store<any>>();

/**
 * Write every pending debounced value out now.
 *
 * Called when the app leaves the foreground — the last moment Android reliably
 * gives us before it may reclaim the process.
 */
export function flushAll(): void {
  registry.forEach(st => st.flush());
}

/**
 * Load every store from disk. Call once, at app start.
 *
 * ONE multiGet, not sixteen getItems.
 *
 * Each store used to hydrate itself, which meant sixteen separate bridge
 * crossings and sixteen SQLite queries before the first frame could settle —
 * all of them on the critical path of a cold start, and all of them waiting on
 * the same single-threaded native module. AsyncStorage batches a multiGet into
 * one round trip and one query, so the boot cost is now one crossing plus the
 * JSON.parse work, which is the part that actually has to happen.
 *
 * A failed multiGet falls back to the per-store path rather than booting with
 * everything empty: an unreadable store is a lost playlist, a silently empty
 * one looks like the app ate the library.
 */
export function hydrateAll(): Promise<unknown> {
  const keys = Array.from(registry.keys());
  return AsyncStorage.multiGet(keys)
    .then(pairs => {
      for (const [key, raw] of pairs) {
        registry.get(key)?.hydrateFrom(raw ?? null);
      }
    })
    .catch(() =>
      // multiGet itself failed (not one key — the whole call). Retry the slow
      // per-store path rather than booting everyone on their defaults: sixteen
      // round trips is a bad cold start, an empty library looks like data loss.
      Promise.all(Array.from(registry.values()).map(st => st.hydrate())),
    );
}

export function createStore<T>(
  key: string,
  initial: T,
  /** Coerce whatever came off disk into a valid T. Corrupt data must not crash
   *  the app — a lost playlist is bad, a boot loop is worse. */
  revive: (raw: unknown) => T,
): Store<T> {
  let value = initial;
  let hydrated = false;
  const listeners = new Set<() => void>();

  const emit = () => listeners.forEach(l => l());

  /**
   * Write to disk on a trailing debounce rather than on every mutation.
   *
   * `set`/`update` are called far more often than once per user action: a
   * single play rewrites the whole recents list AND the stats blob (up to 300
   * tracks, 200 artists and 700 log entries), and each write was a full
   * JSON.stringify of the entire store on the JS thread, synchronously, in the
   * middle of whatever was being rendered. Coalescing the writes costs nothing
   * — the in-memory value is already the source of truth and every read goes
   * there — and it turns a burst of mutations into one serialization.
   *
   * Short enough (250ms) that a write still lands long before the process can
   * realistically go away, and `flush()` covers the one case that matters.
   */
  let writeTimer: ReturnType<typeof setTimeout> | null = null;

  const writeNow = () => {
    writeTimer = null;
    AsyncStorage.setItem(key, JSON.stringify(value)).catch(() => {
      // Storage full or unavailable. Not worth throwing over — the in-memory
      // value is still correct for this session.
    });
  };

  const persist = () => {
    if (writeTimer) {
      return;
    }
    writeTimer = setTimeout(writeNow, 250);
  };

  const store: Store<T> = {
    get: () => value,
    set(next) {
      value = next;
      persist();
      emit();
    },
    update(fn) {
      value = fn(value);
      persist();
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    flush() {
      if (writeTimer) {
        clearTimeout(writeTimer);
        writeNow();
      }
    },
    hydrateFrom(raw) {
      if (hydrated) {
        return;
      }
      hydrated = true;
      try {
        value = raw ? revive(JSON.parse(raw)) : initial;
      } catch {
        value = initial;
      }
      emit();
    },
    async hydrate() {
      if (hydrated) {
        return;
      }
      hydrated = true;
      try {
        const raw = await AsyncStorage.getItem(key);
        value = raw ? revive(JSON.parse(raw)) : initial;
      } catch {
        value = initial;
      }
      emit();
    },
  };

  registry.set(key, store);
  return store;
}

/** Subscribe a component to a store. */
export function useStoreValue<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get);
}

/**
 * Subscribe to a DERIVED VALUE of a store rather than the whole thing.
 *
 * This is what stops one change re-rendering every subscriber. A list row that
 * reads the whole likes array re-renders whenever ANY song is liked; a row that
 * reads `liked: boolean` re-renders only when its own answer flips, because
 * useSyncExternalStore bails out when the snapshot is Object.is-equal to the
 * last one.
 *
 * `select` must return a primitive (or a stable reference). Returning a fresh
 * object or array every call defeats the whole point — React would see a new
 * value every time and re-render anyway.
 */
export function useStoreSelector<T, R>(
  store: Store<T>,
  select: (value: T) => R,
): R {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

export const asArray = <T>(raw: unknown): T[] =>
  Array.isArray(raw) ? (raw as T[]) : [];
