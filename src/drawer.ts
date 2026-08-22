/**
 * The navigation drawer's position, shared.
 *
 * This lives outside the Sidebar component so a gesture ANYWHERE can drive the
 * panel directly, frame by frame, instead of asking the Sidebar to open itself
 * once the gesture is already over.
 *
 * That distinction is the whole point: the drawer used to mount and play its
 * own 220ms open animation when the finger LIFTED, so the panel arrived after
 * the gesture rather than during it. Every app that feels right here — Gmail,
 * Twitter, ChatGPT — has the panel pinned to the fingertip from the first pixel
 * of movement, and lets go into a settle. One Animated.Value that both the
 * gesture and the settle animation write to is what makes that possible.
 */
import {Animated, Dimensions, Easing} from 'react-native';

export const DRAWER_W = Math.min(320, Dimensions.get('window').width * 0.82);

/** -DRAWER_W = fully closed (off-screen left), 0 = fully open. */
export const drawerX = new Animated.Value(-DRAWER_W);

/** How far right the finger must travel before the drag counts as a drawer pull. */
export const DRAWER_GRAB = 10;

/** Pin the panel to the finger. `dx` is distance dragged right from where the
 *  gesture began; the panel never goes past open or past closed. */
export function dragDrawer(dx: number): void {
  drawerX.setValue(Math.max(-DRAWER_W, Math.min(0, -DRAWER_W + dx)));
}

/** Let go: run the rest of the way to open or closed. */
export function settleDrawer(
  open: boolean,
  velocity = 0,
  done?: (finished: boolean) => void,
): void {
  Animated.timing(drawerX, {
    toValue: open ? 0 : -DRAWER_W,
    // A flick finishes quicker than a slow drag — the panel should feel like it
    // carries the momentum the finger gave it.
    duration: velocity > 1.2 ? 140 : 220,
    easing: Easing.out(Easing.cubic),
    useNativeDriver: true,
  }).start(({finished}) => done?.(finished));
}

/** Put the panel back off-screen with no animation — for opening by tap, where
 *  the settle should start from closed rather than from wherever a previous
 *  gesture left it. */
export function resetDrawer(): void {
  drawerX.setValue(-DRAWER_W);
}

/**
 * Should this gesture become a drawer pull?
 *
 * Rightward, and clearly more horizontal than vertical, so a diagonal flick
 * down the page can't be mistaken for one.
 */
export function isDrawerPull(dx: number, dy: number): boolean {
  return dx > DRAWER_GRAB && dx > Math.abs(dy) * 2;
}

/** Did the finger let go far enough (or fast enough) to mean "open"? */
export function shouldOpen(dx: number, vx: number): boolean {
  return dx > DRAWER_W * 0.4 || vx > 0.5;
}
