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
 *   - the neighbour (next or previous song, whichever way you are dragging)
 *     sits one `span` to the side, already drawn, and moves with the finger;
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
  const dir = useSharedValue(0);
  const [neighbour, setNeighbour] = useState<Neighbour | null>(null);
  const neighbourRef = useRef(neighbour);
  neighbourRef.current = neighbour;

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

  const pin = useCallback((d: number) => {
    const t = d === 1 || d === -1 ? peekAdjacentTrack(d) : null;
    setNeighbour(t ? {dir: d as 1 | -1, track: t, art: coverUrl(t)} : null);
  }, []);

  const clear = useCallback(() => setNeighbour(null), []);

  const settle = useCallback(() => {
    const l = landing.current;
    if (!l) {
      return;
    }
    clearTimeout(l.timer);
    landing.current = null;
    // The offset and the flags in one UI-thread step; the neighbour is
    // removed only after, so there is never a frame with neither in place.
    runOnUI(() => {
      'worklet';
      slide.value = 0;
      dir.value = 0;
      busy.value = false;
      runOnJS(clear)();
    })();
  }, [slide, dir, busy, clear]);

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
      const n = neighbourRef.current;
      if (!n || n.dir !== d) {
        // Nothing drawn to glide to (the end of the queue): back to rest,
        // and the new song replaces this one in place.
        busy.value = false;
        dir.value = 0;
        setNeighbour(null);
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
    [slide, span, dir, busy, onGlided],
  );

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-14, 14])
        .failOffsetY([-failY, failY])
        .onUpdate(e => {
          if (busy.value) {
            return;
          }
          slide.value = e.translationX;
          // JS hears only when the direction flips, not every frame.
          const d = e.translationX < 0 ? 1 : e.translationX > 0 ? -1 : 0;
          if (d !== dir.value) {
            dir.value = d;
            runOnJS(pin)(d);
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
          // Back to rest. The neighbour stays drawn until it is fully back
          // off screen; dropping it at release made it vanish mid-view.
          slide.value = withSpring(
            0,
            {
              damping: 20,
              stiffness: 220,
              overshootClamping: true,
              velocity: vx,
            },
            finished => {
              if (finished) {
                dir.value = 0;
                runOnJS(pin)(0);
              }
            },
          );
        }),
    [failY, slide, dir, busy, pin, commit],
  );

  return {gesture, neighbour, span, onCoverLoad};
}
