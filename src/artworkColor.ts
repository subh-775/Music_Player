/**
 * The colour of what's playing.
 *
 * Asks the native side (androidx Palette) for the dominant colour of the
 * artwork, mutes it into one of this app's own dark surfaces, and caches per URL —
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

/**
 * The song's colour as a SURFACE colour — muted and dark, not merely darkened.
 *
 * `toward` scales the channels toward black and leaves saturation exactly where
 * it was, which is why a neon cover produced a neon bar. #00FF3C darkened by
 * half is #007A1E: lower in luminance, every bit as saturated, and against a
 * true-black UI a fully saturated hue reads far louder than its brightness
 * suggests. The mini player under a bright green album turned into a green slab
 * that belonged to no part of the app.
 *
 * Clamping SATURATION is what was missing. Hue is the part worth keeping — it
 * is what makes the bar feel like it belongs to the song — while saturation and
 * lightness are what decide whether it still reads as one of this app's dark
 * surfaces. Pinned rather than scaled, so the result is the same kind of
 * surface whether the cover is neon or nearly grey.
 */
export function surfaceTint(hex: string, lightness: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  if (!Number.isFinite(n)) {
    return '#000000';
  }
  /* eslint-disable no-bitwise -- colour channel math IS bitwise */
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  /* eslint-enable no-bitwise */
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let sat = 0;
  if (max !== min) {
    const d = max - min;
    sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) {
      h = (g - b) / d + (g < b ? 6 : 0);
    } else if (max === g) {
      h = (b - r) / d + 2;
    } else {
      h = (r - g) / d + 4;
    }
    h /= 6;
  }
  // A ceiling, not a scale: a nearly-grey cover keeps its own low saturation
  // and a neon one is brought down to the same restrained level.
  const S = Math.min(sat, 0.34);
  const L = Math.max(0, Math.min(1, lightness));
  const q = L < 0.5 ? L * (1 + S) : L + S - L * S;
  const pp = 2 * L - q;
  const chan = (t: number) => {
    let x = t;
    if (x < 0) {
      x += 1;
    }
    if (x > 1) {
      x -= 1;
    }
    if (x < 1 / 6) {
      return pp + (q - pp) * 6 * x;
    }
    if (x < 1 / 2) {
      return q;
    }
    if (x < 2 / 3) {
      return pp + (q - pp) * (2 / 3 - x) * 6;
    }
    return pp;
  };
  const to255 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  const out = [chan(h + 1 / 3), chan(h), chan(h - 1 / 3)].map(to255);
  return `#${out.map(v => v.toString(16).padStart(2, '0')).join('')}`;
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
