/**
 * The full player's position, shared — and the two artwork rects that let it
 * morph into the mini player instead of merely sliding past it.
 *
 * Same reasoning as `src/drawer.ts`, and the same shape: a Reanimated shared
 * value outside the component, so a gesture ANYWHERE can drive the sheet frame
 * by frame on the UI thread rather than asking PlayerScreen to animate itself
 * once the finger has already let go. That is what lets a drag UP on the mini
 * player open the panel under the fingertip — the mini player and the sheet are
 * different components, and a `useSharedValue` inside one of them is not
 * reachable from the other.
 *
 * ## The morph
 *
 * There is no shared-element library here and there does not need to be. Both
 * artworks are already on screen at once (PlayerScreen sits at zIndex 30 over a
 * mini player that is never unmounted), they show the SAME image at the same
 * moment, and the sheet's own travel already moves the big one most of the way.
 * All that was missing is where the two squares actually are.
 *
 * So each side reports its own on-screen rect here, measured rather than
 * derived: `measureInWindow` on both, in the same coordinate space, so the
 * status bar and the navigation bar cancel out instead of having to be guessed
 * at. Nothing is hardcoded, which means rotation, a font-scale change or a
 * relayout fixes itself on the next frame.
 */
import {Dimensions} from 'react-native';
import {
  Easing,
  makeMutable,
  runOnJS,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

/**
 * Full sheet travel for the open/close slide — the LONGEST edge, not the
 * height.
 *
 * max(w, h) is the same number in both orientations; a plain `height` read is
 * not, and this activity handles rotation itself rather than being recreated.
 * A portrait height captured in landscape left "closed" only halfway down a
 * portrait screen, with the player still visible.
 */
export const HIDE_Y = (({width, height}) => Math.max(width, height))(
  Dimensions.get('window'),
);

/** 0 = fully open; `closedY()` = fully dismissed. Seeded at HIDE_Y, which is
 *  what `closedY()` also returns until the two covers have been measured. */
export const sheetY: SharedValue<number> = makeMutable(HIDE_Y);

/**
 * How far the finger must travel up from the mini player before the drag counts
 * as an open rather than a stray touch on its way to a button.
 *
 * The SAME number the skip swipe uses for its horizontal threshold, on purpose.
 * The two are raced, so whichever axis reaches 14px first takes the touch —
 * symmetric, and a diagonal drag resolves to whichever way it is actually
 * leaning. A smaller number here would let a lazy diagonal open the player
 * when the thumb plainly meant to skip.
 */
export const EXPAND_GRAB = 14;

/** A square on screen, in window coordinates. */
export type Rect = {x: number; y: number; size: number};

/**
 * Where each artwork is right now.
 *
 * Shared values rather than plain module variables because the morph reads them
 * from a worklet on the UI thread, sixty times a second, while a JS-side
 * `measureInWindow` callback may be writing them. A shared value is the only
 * thing here both sides can touch.
 *
 * `size: 0` means "not measured yet", and every reader treats that as "no
 * morph" — a cover that has not been laid out must never move the sheet to
 * coordinate 0.
 */
export const miniArt: SharedValue<Rect> = makeMutable({x: 0, y: 0, size: 0});
export const bigArt: SharedValue<Rect> = makeMutable({x: 0, y: 0, size: 0});

/**
 * The mini player's cover radius, and the value the morph rounds down to.
 *
 * It lives here rather than in PlayerBar because the morph is the thing that
 * has to agree with it — PlayerBar imports it back for its own style, so there
 * is exactly one number and no chance of the two drifting apart. The bar's
 * concentric-corner rule (outer radius = inner radius + padding) is built on
 * top of it there.
 */
export const MINI_ART_RADIUS = 6;

/** The full player's cover radius — the other end of the interpolation. */
export const BIG_ART_RADIUS = 10;

/**
 * How far the sheet travels while the artwork is shrinking.
 *
 * The sheet's own downward translation does ALL of the vertical work: by the
 * time it has moved this far, the big cover is sitting exactly where the mini
 * cover is, and the morph is finished. Past that point the artwork holds
 * position (see the counter-translate in PlayerScreen) while the rest of the
 * panel carries on off the bottom of the screen.
 *
 * Takes both rects as ARGUMENTS rather than reading the shared values itself,
 * and that is not stylistic. Reanimated builds a style's dependency list from
 * the shared values a worklet touches DIRECTLY; one that reached `miniArt` and
 * `bigArt` from in here would hide them from that scan, and the styles built on
 * it would be computed once and then never update again. Every caller reads the
 * values in its own body, where they are seen.
 *
 * Clamped to a sane minimum so a mid-layout read — or a device where the two
 * squares genuinely overlap — can never divide by something near zero and send
 * the progress to infinity.
 */
export function spanBetween(mini: Rect, big: Rect): number {
  'worklet';
  if (!mini.size || !big.size) {
    return HIDE_Y;
  }
  return Math.max(120, mini.y + mini.size / 2 - (big.y + big.size / 2));
}

/**
 * Where the big cover should be drawn for a given sheet position.
 *
 * The whole morph in one pure function, so it can be checked rather than
 * eyeballed: at the end of the travel the numbers below must place the big
 * square EXACTLY on top of the small one, or the hand-off to the real mini
 * player shows as a jump at the last moment. `__tests__/playerMorph.test.ts`
 * asserts that.
 *
 * - `dx` is a plain centre-to-centre difference. RN applies a translate in the
 *   PARENT's coordinate space whatever comes after it in the transform list,
 *   so a scale later in the array needs no correction here.
 * - `dy` is zero for the whole of the morph: the sheet is already carrying the
 *   artwork down one-for-one, and `spanBetween` is defined as exactly the
 *   distance at which that lands it on the mini slot. Past that point the panel
 *   keeps going and the cover must not, so it subtracts the overshoot and
 *   parks.
 * - `radius` is divided by the scale, because a corner radius shrinks with the
 *   view it is on: asking for 6 at scale 0.14 would paint a corner under a
 *   pixel wide. What has to interpolate on SCREEN is `radius * scale`.
 */
export function morphTransform(mini: Rect, big: Rect, y: number) {
  'worklet';
  // Nothing measured yet — the first frame after mount, or an old layout
  // mid-rotation. The identity, so the panel degrades to a plain slide rather
  // than shrinking the cover toward a square it does not know the size of.
  //
  // The guard lives HERE rather than at the call site because every reader of
  // this function needs it and only one of them had it.
  if (!mini.size || !big.size) {
    return {p: 0, scale: 1, dx: 0, dy: 0, radius: BIG_ART_RADIUS};
  }
  const span = spanBetween(mini, big);
  const p = Math.min(1, Math.max(0, y / span));
  const scale = 1 + (mini.size / big.size - 1) * p;
  return {
    p,
    scale,
    dx: (mini.x + mini.size / 2 - (big.x + big.size / 2)) * p,
    dy: -Math.max(0, y - span),
    radius: (BIG_ART_RADIUS + (MINI_ART_RADIUS - BIG_ART_RADIUS) * p) / scale,
  };
}

/**
 * Park the panel ready to open, with no animation — for opening by TAP, where
 * the settle should start from a known place rather than from wherever a
 * previous gesture left it.
 *
 * At the SPAN, not at HIDE_Y, for the same reason the upward drag starts there:
 * everything above the span is invisible (the backdrop has faded out and the
 * cover is parked exactly on the mini player's), so the two look identical at
 * rest — but an open that begins at HIDE_Y spends its first 40% travelling
 * through that invisible stretch, and the morph only gets the tail of the
 * animation. Starting here gives the whole 260ms to the part you can see.
 */
export function resetPlayer(): void {
  sheetY.value = closedY();
}

/**
 * Where the sheet rests when the player is closed.
 *
 * The SPAN, not a whole screen height. Everything past the span is invisible —
 * the backdrop has faded out and the cover is parked exactly on the mini
 * player's — so travelling it is time the animation spends showing nothing.
 * Closing used to spend 44% of its duration down there, which is why the
 * dismissal appeared to finish and then take a moment longer to let go.
 *
 * It is also where an open begins, so open and close are now the same journey
 * in opposite directions rather than two different lengths.
 */
export function closedY(): number {
  'worklet';
  return spanBetween(miniArt.value, bigArt.value);
}

/**
 * Let go: run the rest of the way to open or closed.
 *
 * A flick finishes quicker than a slow drag, so the panel keeps whatever
 * momentum the finger gave it — the same easing and the same reasoning as
 * `settleDrawer`.
 */
export function settlePlayer(
  open: boolean,
  velocity = 0,
  done?: (finished: boolean) => void,
): void {
  sheetY.value = withTiming(
    open ? 0 : closedY(),
    {
      duration: Math.abs(velocity) > 1500 ? 190 : open ? 260 : 280,
      easing: Easing.out(Easing.cubic),
    },
    finished => {
      'worklet';
      if (done) {
        runOnJS(done)(!!finished);
      }
    },
  );
}
