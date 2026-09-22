/**
 * The colour of what's playing.
 *
 * Asks the native side (androidx Palette) for the dominant colour of the
 * artwork, blends it toward black so text stays readable, and caches per URL —
 * a song's colour never changes, so one lookup a track is the ceiling.
 *
 * The THUMB, never the player-size cover. `artworkColor` on the native side is
 * a raw HttpURLConnection — a second, separate download of an image Fresco is
 * already fetching for the <Image> beside it, competing for the same link as
 * the audio stream trying to start. Palette samples the bitmap down to ~112px
 * before it looks at a single pixel, so the other 400 lines were being decoded
 * and thrown away. The 150x150 is also the exact URL every track row has
 * already pulled, so on a list it is usually free twice over.
 *
 * Everything degrades to `null` (plain dark background): an old APK without
 * the native method, a bad URL, an unreadable image — none of them may cost
 * more than the tint.
 */
import {useEffect, useState} from 'react';
import {NativeModules} from 'react-native';
import {thumbArtwork} from './tracks';

type AudioNative = {artworkColor?: (url: string) => Promise<string | null>};

const native = (NativeModules.Audio ?? {}) as AudioNative;

const cache = new Map<string, string | null>();

/** Blend a #rrggbb toward black; t=0 keeps the colour, t=1 is black. */
export function toward(hex: string, t: number): string {
  /* eslint-disable no-bitwise -- colour channel math IS bitwise */
  const n = parseInt(hex.replace('#', ''), 16);
  if (!Number.isFinite(n)) {
    return '#000000';
  }
  const f = (v: number) => Math.round(v * (1 - t));
  const r = f((n >> 16) & 0xff);
  const g = f((n >> 8) & 0xff);
  const b = f(n & 0xff);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
  /* eslint-enable no-bitwise */
}

export async function getArtworkColor(raw: string): Promise<string | null> {
  const url = thumbArtwork(raw);
  if (!url || typeof native.artworkColor !== 'function') {
    return null;
  }
  if (cache.has(url)) {
    return cache.get(url) ?? null;
  }
  try {
    const color = await native.artworkColor(url);
    cache.set(url, color ?? null);
    // Session cache, capped: a long listening session shouldn't hold every
    // cover's colour forever.
    if (cache.size > 200) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    return color ?? null;
  } catch {
    cache.set(url, null);
    return null;
  }
}

/** The artwork's colour, or null while unknown / unavailable. */
export function useArtworkColor(url?: string): string | null {
  // Seeded through thumbArtwork too, or the synchronous hit would always miss:
  // getArtworkColor keys the cache by the THUMB, and the player-size URL is
  // what every caller passes in. A miss here is only a wasted frame of plain
  // background, which is exactly the flicker this seed exists to prevent.
  const [color, setColor] = useState<string | null>(
    url ? cache.get(thumbArtwork(url)) ?? null : null,
  );

  useEffect(() => {
    let alive = true;
    if (!url) {
      setColor(null);
      return;
    }
    getArtworkColor(url).then(c => {
      if (alive) {
        setColor(c);
      }
    });
    return () => {
      alive = false;
    };
  }, [url]);

  return color;
}
