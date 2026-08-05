/**
 * Listening history — what "Your sound" and Search's "Your artists" are built
 * from.
 *
 * Recently-played only keeps the last 20 songs, which is enough for a row on
 * Home and useless for "who do you actually listen to". This counts plays
 * instead: one bump per track START (same hook as recently-played), kept in two
 * small maps so a top-N read is a sort rather than a scan of history.
 *
 * Bounded on purpose — a play counter that grows forever is a storage leak on a
 * phone. When a map is full the least-recently-played half is dropped, so the
 * artists you still listen to survive and the one-off from a year ago doesn't.
 */
import {useMemo} from 'react';
import {createStore, useStoreValue} from './storage';
import {getTrackId, splitArtists} from './tracks';
import type {Track} from './backend';

export type TrackStat = {track: Track; count: number; last: number};
export type ArtistStat = {name: string; image?: string; count: number; last: number};

type Stats = {
  tracks: Record<string, TrackStat>;
  artists: Record<string, ArtistStat>;
  plays: number;
};

const MAX_TRACKS = 300;
const MAX_ARTISTS = 200;
const EMPTY: Stats = {tracks: {}, artists: {}, plays: 0};

function normalize(raw: unknown): Stats {
  const s = (raw ?? {}) as Partial<Stats>;
  return {
    tracks: s.tracks && typeof s.tracks === 'object' ? s.tracks : {},
    artists: s.artists && typeof s.artists === 'object' ? s.artists : {},
    plays: typeof s.plays === 'number' ? s.plays : 0,
  };
}

const store = createStore<Stats>('mp.stats.v1', EMPTY, normalize);

/** Drop the least-recently-played half once a map is over its cap. */
function trim<T extends {last: number}>(
  map: Record<string, T>,
  max: number,
): Record<string, T> {
  const keys = Object.keys(map);
  if (keys.length <= max) {
    return map;
  }
  const keep = keys
    .sort((a, b) => map[b].last - map[a].last)
    .slice(0, Math.floor(max / 2));
  const next: Record<string, T> = {};
  for (const k of keep) {
    next[k] = map[k];
  }
  return next;
}

/** One play of `track`. Called from recentlyPlayed.remember, so every path that
 *  starts a song counts exactly once. */
export function recordPlay(track: Track): void {
  if (!track?.title) {
    return;
  }
  const now = Date.now();
  const id = getTrackId(track);
  store.update(prev => {
    const tracks = {...prev.tracks};
    const seen = tracks[id];
    tracks[id] = {
      // Keep the newer metadata — enrichment may have cleaned it up since.
      track,
      count: (seen?.count ?? 0) + 1,
      last: now,
    };

    const artists = {...prev.artists};
    for (const name of splitArtists(track.artist || '')) {
      const key = name.toLowerCase();
      const a = artists[key];
      artists[key] = {
        name,
        image: a?.image || track.artwork_url,
        count: (a?.count ?? 0) + 1,
        last: now,
      };
    }

    return {
      tracks: trim(tracks, MAX_TRACKS),
      artists: trim(artists, MAX_ARTISTS),
      plays: prev.plays + 1,
    };
  });
}

export function clearStats(): void {
  store.set(EMPTY);
}

function byCount<T extends {count: number; last: number}>(a: T, b: T): number {
  return b.count - a.count || b.last - a.last;
}

export function useStats(): {
  topTracks: TrackStat[];
  topArtists: ArtistStat[];
  plays: number;
} {
  const s = useStoreValue(store);
  return useMemo(
    () => ({
      topTracks: Object.values(s.tracks).sort(byCount),
      topArtists: Object.values(s.artists).sort(byCount),
      plays: s.plays,
    }),
    [s],
  );
}
