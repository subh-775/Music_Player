/**
 * Recent searches — the list under the search field before you've typed.
 *
 * Most-recent first, de-duplicated case-insensitively (searching the same thing
 * twice moves it to the top rather than adding a second row), capped so the
 * list stays scannable.
 */
import {createStore, asArray, useStoreValue} from './storage';

const MAX = 20;

const store = createStore<string[]>('mp.searchHistory.v1', [], raw =>
  asArray<string>(raw)
    .filter(x => typeof x === 'string' && x.trim())
    .slice(0, MAX),
);

export const hydrateSearchHistory = store.hydrate;

export function rememberSearch(query: string): void {
  const q = (query || '').trim();
  if (!q) {
    return;
  }
  store.update(list => [
    q,
    ...list.filter(x => x.toLowerCase() !== q.toLowerCase()),
  ].slice(0, MAX));
}

export function forgetSearch(query: string): void {
  store.update(list => list.filter(x => x !== query));
}

export function clearSearchHistory(): void {
  store.set([]);
}

export function useSearchHistory(): string[] {
  return useStoreValue(store);
}
