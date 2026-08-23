/**
 * The navigation drawer's position, shared — and living on the UI thread.
 *
 * This is outside the Sidebar component so a gesture ANYWHERE can drive the
 * panel directly, frame by frame, instead of asking the Sidebar to open itself
 * once the gesture is already over. Every app that feels right here — Gmail,
 * Twitter, ChatGPT — has the panel pinned to the fingertip from the first pixel
 * of movement, and lets go into a settle.
 *
 * It is a Reanimated shared value, not an Animated.Value, and that matters: an
 * Animated.Value is written from JavaScript, so every frame of the drag was a
 * JS-thread write queued behind whatever else React was doing. A shared value
 * is written from the gesture worklet on the UI thread, so the panel keeps
 * tracking the finger even while JS is busy.
 */
import {Dimensions} from 'react-native';
import {
  Easing,
  makeMutable,
  runOnJS,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

export const DRAWER_W = Math.min(320, Dimensions.get('window').width * 0.82);

/** -DRAWER_W = fully closed (off-screen left), 0 = fully open. */
export const drawerX: SharedValue<number> = makeMutable(-DRAWER_W);

/** How far right the finger must travel before the drag counts as a drawer pull. */
export const DRAWER_GRAB = 12;

/**
 * Let go: run the rest of the way to open or closed.
 *
 * Called from JS — a tap on the hamburger, or the gesture's onEnd after one
 * runOnJS hop. Assigning an animation to a shared value from JS is fine; what
 * matters is that the DRAG itself never came back to JS, and it doesn't: the
 * per-frame writes happen in the gesture worklet.
 */
export function settleDrawer(
  open: boolean,
  velocity = 0,
  done?: (finished: boolean) => void,
): void {
  drawerX.value = withTiming(
    open ? 0 : -DRAWER_W,
    {
      // A flick finishes quicker than a slow drag — the panel should feel like
      // it carries the momentum the finger gave it.
      duration: velocity > 1.2 ? 140 : 220,
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

/** Put the panel back off-screen with no animation — for opening by tap, where
 *  the settle should start from closed rather than from wherever a previous
 *  gesture left it. */
export function resetDrawer(): void {
  drawerX.value = -DRAWER_W;
}

/** Did the finger let go far enough (or fast enough) to mean "open"? */
export function shouldOpen(dx: number, vx: number): boolean {
  'worklet';
  return dx > DRAWER_W * 0.4 || vx > 500;
}
