/**
 * Swipe the cover sideways to change song: the gesture both players share,
 * built to feel like the player's morph.
 *
 * What makes the morph feel good is that it never cuts: the cover is under
 * the finger 1:1, and a release carries on at the finger's speed. The swipe
 * used to do neither. It moved at half the finger's speed, and on release the
 * cover flew out, jumped to the far side and came back in as the new song:
 * two animations with a cut between them.
 *
 * Now it is a carousel of three:
 *   - both neighbours (previous and next song) sit one `span` to either side,
 *     drawn in advance whenever the song changes, and move with the finger.
 *     A drag itself does no React work at all, only UI-thread transforms: the
 *     first version built the neighbour when the drag began, and that rebuild
 *     showed up on the phone as slow UI-thread frames right as the finger
 *     started moving;
 *   - a release glides on with the finger's velocity until the neighbour is
 *     exactly where the cover was;
 *   - then the swap. The neighbour stays parked in the middle until the real
 *     cover underneath shows the same song, loaded, and only then is the
 *     offset reset (offscreen, in one UI-thread step). So the moment of the
 *     swap is invisible: both views show the same picture.
 *
 * `span` is the distance between neighbours: the width of the clip the slides
 * live in. The caller sets it.
 */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Gesture} from 'react-native-gesture-handler';
import {
  runOnJS,
  runOnUI,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import type {Track as RNTPTrack} from 'react-native-track-player';
import {getBestArtworkUrl} from './tracks';
import {
  peekAdjacentTrack,
  skipNext,
  skipPrevious,
  sourceTrackFor,
} from './player';

/** Distance, or a flick, that commits a swipe. */
const COMMIT_PX = 64;
const FLICK = 700;
/** Never stay parked on the neighbour longer than this after the glide, even
 *  if the real cover never reports loaded (a broken image, no artwork). */
const LAND_TIMEOUT_MS = 700;

export type Neighbour = {dir: 1 | -1; track: RNTPTrack; art: string};
export type Sides = {prev: Neighbour | null; next: Neighbour | null};

const NONE: Sides = {prev: null, next: null};

function side(dir: 1 | -1): Neighbour | null {
  const t = peekAdjacentTrack(dir);
  return t ? {dir, track: t, art: coverUrl(t)} : null;
}

function same(a: Neighbour | null, b: Neighbour | null): boolean {
  return (
    a === b ||
    (!!a && !!b && a.art === b.art && trackKey(a.track) === trackKey(b.track))
  );
}

/** The cover URL a player shows for this track — the same rule both use. */
export function coverUrl(t: RNTPTrack | null | undefined): string {
  if (!t) {
    return '';
  }
  const src = sourceTrackFor(t);
  return src ? getBestArtworkUrl(src) : String(t.artwork ?? '');
}

export function trackKey(t: RNTPTrack | null | undefined): string {
  return t ? `${t.title ?? ''}\u0000${t.artist ?? ''}` : '';
}

export function useSongSwipe({
  slide,
  active,
  failY,
}: {
  /** The horizontal offset the caller's cover and title are drawn at. */
  slide: SharedValue<number>;
  active: RNTPTrack | null | undefined;
  /** Vertical travel that hands the touch to the other gesture. */
  failY: number;
}) {
  const span = useSharedValue(0);
  /** Set from a commit until the swap: a second swipe waits for it. */
  const busy = useSharedValue(false);
  const [sides, setSides] = useState<Sides>(NONE);
  const sidesRef = useRef(sides);
  sidesRef.current = sides;

  const landing = useRef<{
    key: string;
    art: string;
    glided: boolean;
    timer?: ReturnType<typeof setTimeout>;
  } | null>(null);
  const loadedArt = useRef('');
  const activeKey = trackKey(active);
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;

  /** Re-read both neighbours from the queue. Not while landing: the one being
   *  landed on must stay exactly as it is until the swap. A no-op render when
   *  nothing changed. */
  const refresh = useCallback(() => {
    if (landing.current) {
      return;
    }
    const prev = side(-1);
    const next = side(1);
    setSides(cur =>
      same(cur.prev, prev) && same(cur.next, next) ? cur : {prev, next},
    );
  }, []);

  useEffect(refresh, [activeKey, refresh]);

  const settle = useCallback(() => {
    const l = landing.current;
    if (!l) {
      return;
    }
    clearTimeout(l.timer);
    landing.current = null;
    // The offset in one UI-thread step; the neighbours are re-read only
    // after, once they are both back off screen.
    runOnUI(() => {
      'worklet';
      slide.value = 0;
      busy.value = false;
      runOnJS(refresh)();
    })();
  }, [slide, busy, refresh]);

  const tryLand = useCallback(() => {
    const l = landing.current;
    if (
      l?.glided &&
      activeKeyRef.current === l.key &&
      (!l.art || loadedArt.current === l.art)
    ) {
      settle();
    }
  }, [settle]);

  useEffect(tryLand, [activeKey, tryLand]);

  /** Wire to the real cover's Image onLoad. */
  const onCoverLoad = useCallback(
    (url: string) => {
      loadedArt.current = url;
      tryLand();
    },
    [tryLand],
  );

  const onGlided = useCallback(() => {
    const l = landing.current;
    if (!l) {
      return;
    }
    l.glided = true;
    l.timer = setTimeout(settle, LAND_TIMEOUT_MS);
    tryLand();
  }, [settle, tryLand]);

  const commit = useCallback(
    (d: 1 | -1, velocity: number) => {
      // Skip NOW, so the engine and the title move while the cover glides.
      (d === 1 ? skipNext() : skipPrevious(true)).catch(() => {});
      const n = d === 1 ? sidesRef.current.next : sidesRef.current.prev;
      if (!n) {
        // Nothing drawn to glide to (the end of the queue): back to rest,
        // and the new song replaces this one in place.
        busy.value = false;
        slide.value = withSpring(0, {damping: 20, stiffness: 220});
        return;
      }
      landing.current = {key: trackKey(n.track), art: n.art, glided: false};
      slide.value = withSpring(
        -d * span.value,
        {damping: 26, stiffness: 260, overshootClamping: true, velocity},
        finished => {
          if (finished) {
            runOnJS(onGlided)();
          }
        },
      );
    },
    [slide, span, busy, onGlided],
  );

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-14, 14])
        .failOffsetY([-failY, failY])
        .onStart(() => {
          // Catches a queue edited since the song began (play next, a
          // shuffle). Renders nothing unless a neighbour actually changed.
          runOnJS(refresh)();
        })
        .onUpdate(e => {
          if (!busy.value) {
            slide.value = e.translationX;
          }
        })
        .onEnd((e, success) => {
          if (busy.value) {
            return;
          }
          const x = e.translationX;
          const vx = e.velocityX;
          const next = success && x < 0 && (x <= -COMMIT_PX || vx < -FLICK);
          const prev = success && x > 0 && (x >= COMMIT_PX || vx > FLICK);
          if (next || prev) {
            busy.value = true;
            runOnJS(commit)(next ? 1 : -1, vx);
            return;
          }
          slide.value = withSpring(0, {
            damping: 20,
            stiffness: 220,
            overshootClamping: true,
            velocity: vx,
          });
        }),
    [failY, slide, busy, refresh, commit],
  );

  return {gesture, sides, span, onCoverLoad};
}
