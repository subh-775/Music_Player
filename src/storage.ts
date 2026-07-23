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
};

/** Every store built here, so one call at startup can load all of them. This
 *  is also why no store needs to import any other one just to be hydrated. */
const registry: Array<() => Promise<void>> = [];

/** Load every store from disk, in parallel. Call once, at app start. */
export function hydrateAll(): Promise<void[]> {
  return Promise.all(registry.map(h => h()));
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

  const persist = () => {
    AsyncStorage.setItem(key, JSON.stringify(value)).catch(() => {
      // Storage full or unavailable. Not worth throwing over — the in-memory
      // value is still correct for this session.
    });
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

  registry.push(store.hydrate);
  return store;
}

/** Subscribe a component to a store. */
export function useStoreValue<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get);
}

export const asArray = <T,>(raw: unknown): T[] =>
  Array.isArray(raw) ? (raw as T[]) : [];
