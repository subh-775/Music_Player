/**
 * The full player's position, shared — and the geometry that lets it become the
 * mini player rather than merely sliding past it.
 *
 * Same reasoning as `src/drawer.ts`, and the same shape: a Reanimated shared
 * value outside the component, so a gesture ANYWHERE can drive the panel frame
 * by frame on the UI thread rather than asking PlayerScreen to animate itself
 * once the finger has already let go. That is what lets a drag UP on the mini
 * player open the panel under the fingertip — the mini player and the panel are
 * different components, and a `useSharedValue` inside one is not reachable from
 * the other.
 *
 * ## The transition
 *
 * There is no shared-element library here and there does not need to be. Both
 * artworks are already on screen at once (PlayerScreen sits at zIndex 30 over a
 * mini player that is never unmounted), they show the SAME image at the same
 * moment, and the panel's own travel already moves the big one most of the way.
 * All that was missing is where the two squares actually are.
 *
 * So each side reports its own on-screen rect (`measureInWindow`), in the same
 * coordinate space, so the status bar and the navigation bar cancel out instead
 * of having to be guessed at. Nothing is hardcoded, so rotation, a font-scale
 * change or a relayout fixes itself on the next frame.
 *
 * ## State is a PROPORTION; measurements are only ever geometry
 *
 * This separation is the hard-won part, and every bug this file has had came
 * from blurring it. `sheetP` says how far along the transition is, 0 to 1, and
 * nothing measured can change it. Pixels — how far to slide, how much to
 * shrink, where to land — are derived from it and the current measurements,
 * fresh every frame.
 *
 * It used to be the other way round: the value held PIXELS, and progress was
 * `pixels / measuredSpan`. The closed position was therefore a pixel figure
 * snapshotted when the dismissal began, while the span kept being re-measured —
 * so anything that relaid the mini player out afterwards (a song change, a
 * Bluetooth device appearing in the bar) moved the finish line out from under a
 * value already parked. Progress settled at 0.93 rather than 1, the cover
 * stopped short of the slot, and a second artwork sat there off to one side.
 * Different measurement timings on different launches is precisely why it
 * behaved differently every time the app was opened.
 */
import {Dimensions} from 'react-native';
import {
  Easing,
  makeMutable,
  runOnJS,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

/** The window, for the cases where a frame has not been measured yet. The
 *  panel fills the window, so this is not an estimate. */
const SCREEN = Dimensions.get('window');

/**
 * A fallback travel distance, used only until both covers have been measured.
 *
 * The LONGEST edge, not the height: max(w, h) is the same number in both
 * orientations, and this activity handles rotation itself rather than being
 * recreated, so a portrait height captured in landscape would be wrong.
 */
export const FALLBACK_SPAN = Math.max(SCREEN.width, SCREEN.height);

/**
 * How far along the transition the panel is: **0 fully open, 1 fully closed.**
 *
 * A proportion, never pixels — see the note at the top of this file for what
 * went wrong when it was the other way round. Closed is the number 1, and
 * nothing measured can move it.
 */
export const sheetP: SharedValue<number> = makeMutable(1);

/** How far the finger must travel before a drag counts as an open rather than
 *  a stray touch on its way to a button. The SAME number the skip swipe uses
 *  horizontally, so a diagonal resolves to whichever way it is leaning. */
export const EXPAND_GRAB = 14;

/** A square on screen, in window coordinates. */
export type Rect = {x: number; y: number; size: number};

/** A rectangle on screen, in window coordinates — the two SURFACES that morph
 *  into each other, as opposed to the two covers. */
export type Box = {x: number; y: number; w: number; h: number};

/**
 * Where each artwork is right now.
 *
 * Shared values rather than plain module variables because the transition reads
 * them from a worklet on the UI thread, sixty times a second, while a JS-side
 * `measureInWindow` callback may be writing them. A shared value is the only
 * thing here both sides can touch.
 *
 * `size: 0` means "not measured yet", and every reader treats that as "no
 * morph" — a cover that has not been laid out must never move anything to
 * coordinate 0.
 */
export const miniArt: SharedValue<Rect> = makeMutable({x: 0, y: 0, size: 0});
export const bigArt: SharedValue<Rect> = makeMutable({x: 0, y: 0, size: 0});

/** `miniBar` is the floating bar's own frame; `sheetRect` is the full panel's,
 *  measured with its current offset taken back out so it describes where the
 *  panel sits when open. */
export const miniBar: SharedValue<Box> = makeMutable({x: 0, y: 0, w: 0, h: 0});
export const sheetRect: SharedValue<Box> = makeMutable({
  x: 0,
  y: 0,
  w: 0,
  h: 0,
});

/** The mini bar's corner radius — PAD + MINI_ART_RADIUS, concentric with its
 *  artwork. The panel's corners interpolate to exactly this, and PlayerBar
 *  builds its own corner from the same constant so the two cannot drift. */
export const MINI_BAR_RADIUS = 11;

/** The mini player's cover radius, and what the big cover rounds down to. */
export const MINI_ART_RADIUS = 6;

/** The full player's cover radius — the other end of that interpolation. */
export const BIG_ART_RADIUS = 10;

/**
 * How far the panel slides while the artwork is shrinking.
 *
 * The panel's own downward travel does ALL of the vertical work: by the time it
 * has moved this far, the big cover is sitting exactly where the mini cover is.
 *
 * Takes both rects as ARGUMENTS rather than reading the shared values itself,
 * and that is not stylistic. Reanimated builds a style's dependency list from
 * the shared values a worklet touches DIRECTLY; one that reached `miniArt` and
 * `bigArt` from in here would hide them from that scan, and the styles built on
 * it would be computed once and then never update again. Every caller reads the
 * values in its own body, where they are seen.
 *
 * Clamped to a sane minimum so a mid-layout read — or a device where the two
 * squares genuinely overlap — can never divide by something near zero.
 */
export function spanBetween(mini: Rect, big: Rect): number {
  'worklet';
  if (!mini.size || !big.size) {
    return FALLBACK_SPAN;
  }
  return Math.max(120, mini.y + mini.size / 2 - (big.y + big.size / 2));
}

/**
 * Where the big cover should be drawn at a given point in the transition.
 *
 * The whole thing in one pure function, so it can be checked rather than
 * eyeballed: at `p = 1` the numbers below must place the big square EXACTLY on
 * top of the small one, or the hand-off shows as a jump at the last moment.
 *
 * - `dx` is a plain centre-to-centre difference. RN applies a translate in the
 *   PARENT's coordinate space whatever comes after it in the transform list, so
 *   a scale later in the array needs no correction here.
 * - `dy` is zero throughout. The panel is already carrying the cover down by
 *   `span * p`, and `span` is defined as exactly the distance at which that
 *   lands it on the mini slot — so the cover simply rides along. There is no
 *   overshoot to undo, because the panel now stops AT the span rather than
 *   continuing a whole screen past it.
 * - `radius` is divided by the scale, because a corner radius shrinks with the
 *   view it is on: asking for 6 at scale 0.14 would paint a corner under a
 *   pixel wide. What has to interpolate on SCREEN is `radius * scale`.
 */
export function morphTransform(mini: Rect, big: Rect, p: number) {
  'worklet';
  // Clamped rather than trusted: the geometry below must not be asked to
  // extrapolate past either rectangle.
  const t = Math.min(1, Math.max(0, p));
  const span = spanBetween(mini, big);
  // Only the GEOMETRY degrades when nothing has been measured — no scaling, no
  // travel toward a square whose size is unknown. `p` still comes back
  // untouched, because the mini player's own visibility depends on it and a bar
  // that hides itself is not a fallback, it is a brick. That exact mistake
  // shipped once: the unmeasured branch returned `p: 0`, reading "no morph" as
  // "fully open", so on a fresh launch the bar computed zero opacity and
  // vanished — taking with it the only control that opens the panel whose
  // layout would have measured it.
  if (!mini.size || !big.size) {
    return {p: t, span, scale: 1, dx: 0, dy: 0, radius: BIG_ART_RADIUS};
  }
  const scale = 1 + (mini.size / big.size - 1) * t;
  return {
    p: t,
    span,
    scale,
    dx: (mini.x + mini.size / 2 - (big.x + big.size / 2)) * t,
    dy: 0,
    radius: (BIG_ART_RADIUS + (MINI_ART_RADIUS - BIG_ART_RADIUS) * t) / scale,
  };
}

/**
 * How visible the mini player is at a given point in the transition.
 *
 * The bar fades in on the TAIL. Without that it sat at full strength behind a
 * panel that was itself fading out, so half way through a dismissal there were
 * two players on screen — the cover shrinking toward a bar already drawn
 * underneath it. Held at zero until the panel's surface has shrunk to roughly
 * bar-sized, then brought in over the last stretch, by which point the two are
 * the same rectangle in the same place and the crossing is not a visible event.
 *
 * ## The guard is not optional
 *
 * An unmeasured `bigArt` returns 1, not 0, and it is checked here rather than
 * left to the arithmetic. This function decides whether the ONLY control that
 * opens the full player is on screen at all: if it ever returns 0 while the
 * player is closed, the app plays music to a screen with no transport on it and
 * no way to get one back. A rule that important should be a line you can read,
 * not an emergent property of a division.
 */
export function miniBarOpacity(big: Rect, p: number): number {
  'worklet';
  if (!big.size) {
    return 1;
  }
  return Math.min(1, Math.max(0, (p - 0.88) / 0.12));
}

/**
 * The panel's surface, on its way to becoming the bar.
 *
 * This is the difference between a panel that VANISHES and one that BECOMES
 * something. Fading a full-screen surface out leaves a large dark shape to
 * dispose of at the end of the gesture, and disposing of it — however smoothly
 * — reads as a flash, because a third of the screen changes brightness in under
 * a tenth of a second. Shrinking it instead means there is never a large shape
 * to get rid of: by the time it disappears it is already bar-sized, bar-shaped
 * and in the bar's place, with the real bar fading up underneath it.
 *
 * Returned in the panel's OWN coordinates, because that is where the view
 * lives. The panel is itself translated down by `offsetY`, so the target has
 * that subtracted back out or the surface would chase the panel downward
 * instead of staying put over the bar.
 *
 * With either rectangle unmeasured this returns the whole window rather than
 * `sheet.w`, which is ZERO until the measurement lands — a zero-width surface
 * is an invisible panel, and this function must never be the reason the player
 * has no background.
 */
export function surfaceRect(
  sheet: Box,
  bar: Box,
  offsetY: number,
  p: number,
): {left: number; top: number; width: number; height: number; radius: number} {
  'worklet';
  if (!sheet.w || !bar.w) {
    return {
      left: 0,
      top: 0,
      width: SCREEN.width,
      height: SCREEN.height,
      radius: 0,
    };
  }
  const lerp = (a: number, b: number) => a + (b - a) * p;
  return {
    // Interpolated in WINDOW space, then converted to the panel's own frame by
    // removing the panel's origin and its current offset.
    left: lerp(sheet.x, bar.x) - sheet.x,
    top: lerp(sheet.y, bar.y) - sheet.y - offsetY,
    width: lerp(sheet.w, bar.w),
    height: lerp(sheet.h, bar.h),
    radius: lerp(0, MINI_BAR_RADIUS),
  };
}

/** Park the panel closed with no animation — for a close that is not a
 *  dismissal (navigating to an artist behind the player), where there is
 *  nothing to watch slide away. */
export function resetPlayer(): void {
  sheetP.value = 1;
}

/**
 * Let go: run the rest of the way to open or closed.
 *
 * Slower than it once was (260/280ms), and deliberately. The morph is the thing
 * being watched now, not just a panel getting out of the way, and at a quarter
 * of a second the eye reads the end state rather than the change. A flick keeps
 * the momentum the finger gave it.
 */
export function settlePlayer(
  open: boolean,
  velocity = 0,
  done?: (finished: boolean) => void,
): void {
  sheetP.value = withTiming(
    open ? 0 : 1,
    {
      duration: Math.abs(velocity) > 1500 ? 300 : open ? 420 : 440,
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
