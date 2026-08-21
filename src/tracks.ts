/**
 * The single vocabulary for "a song".
 *
 * Ported from Fix-Spotify's frontend/src/utils/tracks.js. Identity, artwork
 * choice, source fallback order and enrichment merging all live here so that
 * every screen agrees on what a track IS. Two identity functions in one app
 * drift apart the moment both exist — likes computed with one and dedup with
 * the other stop matching — so this is the only one.
 */
import type {Track} from './backend';

const PLAYABLE_SOURCES = new Set([
  'jiosaavn',
  'soundcloud',
  'youtube',
  'youtube_music',
  'local',
]);

/** Quality-first. The player walks this order when a source fails to stream. */
const SOURCE_ORDER = ['jiosaavn', 'soundcloud', 'youtube_music', 'youtube'];

const TEXT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/&quot;/gi, '"'],
  [/&#34;/g, '"'],
  [/&#39;/g, "'"],
  [/&amp;/gi, '&'],
  [/&apos;/gi, "'"],
  [/Â·/g, '·'],
  [/â€™/g, "'"],
  [/â€œ|â€�/g, '"'],
  [/â€“|â€”/g, '-'],
];

/** Ordered best-to-worst artwork keys. */
const ARTWORK_PRIORITY = [
  '1200',
  '1000',
  '600',
  '500',
  'xl',
  '300',
  'large',
  'source:jiosaavn',
  'source:youtube',
  'source:soundcloud',
  'enriched',
  '100',
  'medium',
  'small',
  'source:itunes',
];

/**
 * Strip the junk sources put in titles: HTML entities, mojibake, and the
 * "(Official Video)" / "| Full HD" / "feat. …" suffixes that make the same song
 * look like three different ones.
 *
 * Note: no textarea-decode step here — that was a DOM trick in the WebView and
 * there is no document in React Native. The explicit entity table above covers
 * what actually shows up in this catalogue.
 */
export function cleanText(value: unknown): string {
  if (value == null) {
    return '';
  }
  let text = String(value);
  TEXT_REPLACEMENTS.forEach(([pattern, replacement]) => {
    text = text.replace(pattern, replacement);
  });

  text = text.replace(
    /\s*[([{].*?(?:official|video|audio|lyric|remaster|live|feat\.|ft\.|full\s+video|hd|4k|visuali[sz]er|music\s+video|song\s+video|original\s+motion|bollywood).*?[)\]}/]/gi,
    '',
  );
  text = text.replace(
    /\s*\|.*(?:official|video|audio|lyric|full|hd|4k|visuali[sz]er)/gi,
    '',
  );
  // Only when the tail is noise — "Artist - Song" must survive intact.
  text = text.replace(/\s+-\s+(?:official|full)\s+.*$/gi, '');
  text = text.replace(/\s+(?:feat\.|ft\.).*$/gi, '');

  return text.replace(/\s+/g, ' ').trim();
}

/** Stable identity for a track. ISRC when known, else cleaned title+artist. */
export function getTrackId(track: Track | null | undefined): string {
  return [
    cleanText(track?.title).toLowerCase(),
    cleanText(track?.artist).toLowerCase(),
    track?.isrc || '',
  ].join('|');
}

/** Ordered playable sources, best quality first. */
export function getPlayableSources(
  track: Track | null | undefined,
): Array<{source: string; url: string}> {
  const srcs = track?.sources || {};
  const out: Array<{source: string; url: string}> = [];
  for (const s of SOURCE_ORDER) {
    const url = srcs[s]?.url;
    if (PLAYABLE_SOURCES.has(s) && url) {
      out.push({source: s, url});
    }
  }
  // Anything playable we didn't name explicitly still counts.
  for (const [s, d] of Object.entries(srcs)) {
    if (PLAYABLE_SOURCES.has(s) && d?.url && !out.some(o => o.source === s)) {
      out.push({source: s, url: d.url});
    }
  }
  return out;
}

export function getPlayableSource(
  track: Track | null | undefined,
): string | null {
  if (!track?.sources) {
    return null;
  }
  const preferred = track.playable_source || track.primary_source;
  if (
    preferred &&
    PLAYABLE_SOURCES.has(preferred) &&
    track.sources[preferred]?.url
  ) {
    return preferred;
  }
  return getPlayableSources(track)[0]?.source ?? null;
}

export function isPlayableTrack(track: Track | null | undefined): boolean {
  // A file on disk is playable even though it has no streaming source.
  return Boolean(track?.file_path) || Boolean(getPlayableSource(track));
}

/** The unique stream URL of a track's chosen source, or ''. */
export function trackStreamUrl(track: Track | null | undefined): string {
  const src = getPlayableSource(track);
  return (src && track?.sources?.[src]?.url) || '';
}

/**
 * True when two objects are the SAME recording.
 *
 * Compares source URL first (unique per recording), falling back to
 * title+artist+duration. This is why a 30-second preview never highlights as
 * the currently-playing full track of the same name.
 */
export function sameTrack(
  a: Track | null | undefined,
  b: Track | null | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }
  const ua = trackStreamUrl(a);
  const ub = trackStreamUrl(b);
  if (ua && ub) {
    return ua === ub;
  }
  const norm = (s?: string) => cleanText(s).toLowerCase();
  return (
    norm(a.title) === norm(b.title) &&
    norm(a.artist) === norm(b.artist) &&
    (a.duration_ms || 0) === (b.duration_ms || 0)
  );
}

/**
 * Raise a cover URL to a usable resolution where the URL pattern allows it.
 *
 * JioSaavn and iTunes both encode the size in the path, so a 150x150 thumbnail
 * can simply be asked for larger. Home cards were rendering those thumbnails
 * at full card width, which is why some of them looked soft or half-loaded.
 */
export function upgradeArtwork(url?: string): string {
  if (!url) {
    return '';
  }
  return url
    .replace(/(\d+)x(\d+)/g, (m, w, h) =>
      parseInt(w, 10) < 500 || parseInt(h, 10) < 500 ? '500x500' : m,
    )
    .replace(/(\d+)x(\d+)bb/g, (m, w) =>
      parseInt(w, 10) < 600 ? '600x600bb' : m,
    );
}

/** Best available cover, upgraded to a usable resolution where the URL allows. */
export function getBestArtworkUrl(track: Track | null | undefined): string {
  const urls = track?.artwork_urls || {};
  let best = '';
  for (const size of ARTWORK_PRIORITY) {
    const url = urls[size];
    if (typeof url === 'string' && url) {
      best = url;
      break;
    }
  }
  if (!best && typeof track?.artwork_url === 'string') {
    best = track.artwork_url;
  }
  if (!best) {
    best = Object.values(urls).find(u => typeof u === 'string' && u) || '';
  }
  if (best) {
    // JioSaavn serves NxN thumbnails; ask for 500 when it offered less.
    best = best.replace(/(\d+)x(\d+)/g, (match, w, h) =>
      parseInt(w, 10) < 500 || parseInt(h, 10) < 500 ? '500x500' : match,
    );
    // iTunes 100x100bb -> 600x600bb.
    best = best.replace(/(\d+)x(\d+)bb/g, (match, w) =>
      parseInt(w, 10) < 600 ? '600x600bb' : match,
    );
  }
  return best;
}

/** Canonical form: cleaned text, resolved source, best artwork baked in. */
export function normalizeTrack(track: Track | null | undefined): Track | null {
  if (!track) {
    return null;
  }
  const playableSource = getPlayableSource(track);
  const bestArt = getBestArtworkUrl(track);

  // Bake the chosen artwork into the dict so it survives a storage round-trip.
  const artworkUrls = {...(track.artwork_urls || {})};
  if (bestArt && !Object.values(artworkUrls).includes(bestArt)) {
    artworkUrls.enriched = bestArt;
  }

  return {
    ...track,
    title: cleanText(track.title),
    artist: cleanText(track.artist),
    album: cleanText(track.album),
    artwork_url: bestArt,
    artwork_urls: artworkUrls,
    primary_source: playableSource || track.primary_source || undefined,
    playable_source: playableSource || undefined,
    is_playable: Boolean(playableSource) || Boolean(track.file_path),
  };
}

export function normalizeTracks(tracks: Track[] = []): Track[] {
  return tracks.map(normalizeTrack).filter((t): t is Track => t !== null);
}

export function playableTracks(tracks: Track[] = []): Track[] {
  return normalizeTracks(tracks).filter(isPlayableTrack);
}

export function uniqueTracks(tracks: Track[] = []): Track[] {
  const seen = new Set<string>();
  return tracks.filter(t => {
    const id = getTrackId(t);
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

/**
 * Split an artist credit into individual names.
 *
 * Never splits on "-", so genuine hyphenated duos survive ("Vishal-Shekhar",
 * "Sachin-Jigar"). "&" IS a separator, which is right far more often than not;
 * the rare joint act written with "&" ("Earth, Wind & Fire") is the trade-off.
 */
export function splitArtists(artist?: string): string[] {
  const cleaned = cleanText(artist);
  if (!cleaned) {
    return [];
  }
  const parts = cleaned.split(
    /\s*,\s*|\s*;\s*|\s*\/\s*|\s+&\s+|\s+feat\.?\s+|\s+ft\.?\s+|\s+x\s+/i,
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (p.length < 2 || seen.has(p.toLowerCase())) {
      continue;
    }
    seen.add(p.toLowerCase());
    out.push(p);
  }
  return out.length ? out : [cleaned];
}

/** "about 53 min" / "3 hr 12 min". '' when nothing carries a duration. */
export function formatTotalDuration(tracks: Track[] = []): string {
  const ms = tracks.reduce((sum, t) => sum + (t?.duration_ms || 0), 0);
  if (ms <= 0) {
    return '';
  }
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) {
    return `about ${totalMin} min`;
  }
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min ? `${hr} hr ${min} min` : `${hr} hr`;
}
