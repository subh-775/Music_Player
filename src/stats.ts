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

/**
 * One play, kept only long enough to answer "this week".
 *
 * `full` is the track's own length; how long you ACTUALLY listened is not
 * stored, because it does not have to be: the log is chronological, so entry i
 * ran until entry i+1 started, and the last entry is still running. Reading it
 * as min(full, next.at - at) is exact for sequential listening and cannot
 * inflate — skipping a song after five seconds counts five seconds, and leaving
 * the app paused for an hour still counts at most one track length.
 *
 * That is the whole reason this is a log of starts rather than a running total:
 * a total would have to be written on every pause, skip and track change, and
 * every one of those is a chance to double-count or miss.
 */
export type Play = {at: number; full: number; src: string};
export type ArtistStat = {name: string; image?: string; count: number; last: number};

type Stats = {
  tracks: Record<string, TrackStat>;
  artists: Record<string, ArtistStat>;
  plays: number;
  /** Newest LAST, so the "ran until the next one" reading is a forward scan. */
  log: Play[];
};

const MAX_TRACKS = 300;
const MAX_ARTISTS = 200;
/** A week of heavy listening is ~600 songs; past that the oldest go first. */
const MAX_LOG = 700;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The cap applied to a play whose track length we never learned.
 *
 * Without one, the last song before the app was closed would be credited with
 * the entire overnight gap — hours of "listening" that never happened. Ten
 * minutes is longer than all but a handful of songs, so it never truncates a
 * real play and it bounds the damage from a missing duration.
 */
const UNKNOWN_LEN = 600;
const EMPTY: Stats = {tracks: {}, artists: {}, plays: 0, log: []};

function normalize(raw: unknown): Stats {
  const s = (raw ?? {}) as Partial<Stats>;
  return {
    tracks: s.tracks && typeof s.tracks === 'object' ? s.tracks : {},
    artists: s.artists && typeof s.artists === 'object' ? s.artists : {},
    plays: typeof s.plays === 'number' ? s.plays : 0,
    // Absent on anything saved before this existed — an empty week, not a crash.
    log: Array.isArray(s.log) ? s.log : [],
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

function playSeconds(track: Track): number {
  // duration_ms is what the backend actually returns; there is no `duration`.
  const ms = Number(track.duration_ms);
  // A track with no length contributes its wall-clock gap uncapped rather than
  // a guessed length — see the cap in useWeek.
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
}

function sourceOf(track: Track): string {
  if (track.file_path) {
    return 'downloads';
  }
  return track.playable_source || track.primary_source || 'unknown';
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

    // Prune by AGE first, then by count. Anything older than a week can never
    // be read again, so it is dropped whether or not the log is full.
    const log = [...prev.log, {at: now, full: playSeconds(track), src: sourceOf(track)}]
      .filter(e => now - e.at < WEEK_MS)
      .slice(-MAX_LOG);

    return {
      tracks: trim(tracks, MAX_TRACKS),
      artists: trim(artists, MAX_ARTISTS),
      plays: prev.plays + 1,
      log,
    };
  });
}

export function clearStats(): void {
  store.set(EMPTY);
}

function byCount<T extends {count: number; last: number}>(a: T, b: T): number {
  return b.count - a.count || b.last - a.last;
}

export type WeekStat = {
  /** Whole minutes of music actually listened to in the last 7 days. */
  minutes: number;
  /** Songs started in the last 7 days. */
  songs: number;
  /** Where they came from, biggest share first. */
  sources: {name: string; songs: number; share: number}[];
  /** Songs per day, oldest first — 7 entries, for the bars. */
  perDay: number[];
};

/**
 * The last seven days, read out of the play log. Pure, so it can be tested.
 *
 * The log records STARTS. How long each play actually ran is derived rather
 * than stored: entry i ran until entry i+1 began, and the last entry is still
 * running. That reading cannot inflate — a song skipped after five seconds
 * counts five seconds — and it needs no write on pause, skip or track change,
 * every one of which would be a chance to double-count or to miss.
 */
export function summarizeWeek(log: Play[], now: number): WeekStat {
  const since = now - WEEK_MS;
  const recent = log.filter(e => e.at >= since).sort((a, b) => a.at - b.at);

  let seconds = 0;
  const bySource = new Map<string, number>();
  const perDay = [0, 0, 0, 0, 0, 0, 0];

  for (let i = 0; i < recent.length; i++) {
    const e = recent[i];
    const until = i + 1 < recent.length ? recent[i + 1].at : now;
    const gap = Math.max(0, Math.round((until - e.at) / 1000));
    // Capped, always: at the track's own length when we know it, at
    // UNKNOWN_LEN when we don't. An uncapped gap is how an app left closed
    // overnight would report eight hours of listening.
    seconds += Math.min(e.full > 0 ? e.full : UNKNOWN_LEN, gap);

    bySource.set(e.src, (bySource.get(e.src) ?? 0) + 1);
    // 0 = six days ago, 6 = today.
    const day = 6 - Math.floor((now - e.at) / DAY_MS);
    if (day >= 0 && day < 7) {
      perDay[day] += 1;
    }
  }

  const songs = recent.length;
  const sources = [...bySource.entries()]
    .map(([name, n]) => ({name, songs: n, share: songs ? n / songs : 0}))
    .sort((a, b) => b.songs - a.songs || a.name.localeCompare(b.name));

  return {minutes: Math.round(seconds / 60), songs, sources, perDay};
}

/**
 * Deliberately NOT on a clock: it recomputes when the log changes, which is
 * once per song. Between songs the numbers cannot move by enough to matter, and
 * a ticking derived value would re-render the screen for nothing.
 */
export function useWeek(): WeekStat {
  const s = useStoreValue(store);
  return useMemo(() => summarizeWeek(s.log, Date.now()), [s]);
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
