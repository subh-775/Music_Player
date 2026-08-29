/**
 * A bottom sheet that is a VIEW, not a window.
 *
 * Every sheet in this app used `<Modal animationType="slide">`, and on Android a
 * Modal is not a view at all — it is a whole new Dialog window. Opening one runs
 * this before a single pixel moves: React mounts the sheet subtree, Android's
 * WindowManager adds a window (a cross-process transaction), and only then does
 * the ~300ms native slide begin. Closing runs the same in reverse, and the whole
 * slide-out must finish before the window can be removed. That is the "the menu
 * opens late and closes late" delay, on both ends.
 *
 * The Sidebar already learned this lesson; the sheets never got the same
 * treatment. This is that treatment, once, so every sheet shares it.
 *
 * Renders as an absolute overlay in whatever full-screen parent it sits in, and
 * animates a plain transform on the UI thread. There is no window, so opening is
 * a translate on views React has already made, and closing is the same in
 * reverse with nothing to tear down.
 */
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  BackHandler,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from 'react-native';
import {Gesture, GestureDetector} from 'react-native-gesture-handler';
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
  withTiming,
} from 'react-native-reanimated';
import {C, S} from '../theme';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Every sheet in the app renders HERE, not where it is written.
 *
 * `zIndex` in React Native only orders siblings inside one parent. A sheet
 * belonging to LibraryScreen lives inside the tabs container; the mini player
 * and the tab bar are siblings of that container which paint after it. No
 * zIndex on the sheet can cross that boundary — so the library's long-press
 * menu was structurally incapable of covering the mini player, and the same
 * went for the collection menu and every panel inside Settings.
 *
 * Hoisting the state for each of those sheets up to App would work and would be
 * a large, error-prone move of ownership. This does the same job by moving the
 * ELEMENTS instead: a Sheet publishes its rendered tree to this registry and
 * renders nothing in place, and <SheetHost /> — mounted once at the app root,
 * above everything — renders whatever is published. Owners keep their state,
 * their props and their callbacks exactly as they are.
 *
 * Hooks still run in the owning component (they are called there); only the
 * output moves. That matters for the gesture and the shared values, which stay
 * bound to the sheet that created them.
 */
type Entry = {id: number; node: React.ReactNode};

let entries: Entry[] = [];
const hostSubs = new Set<() => void>();

function notifyHost(): void {
  hostSubs.forEach(fn => fn());
}

function publish(id: number, node: React.ReactNode): void {
  const at = entries.findIndex(e => e.id === id);
  entries =
    at >= 0
      ? [...entries.slice(0, at), {id, node}, ...entries.slice(at + 1)]
      : [...entries, {id, node}];
  notifyHost();
}

function unpublish(id: number): void {
  const next = entries.filter(e => e.id !== id);
  if (next.length !== entries.length) {
    entries = next;
    notifyHost();
  }
}

function subscribeHost(fn: () => void): () => void {
  hostSubs.add(fn);
  return () => {
    hostSubs.delete(fn);
  };
}

let sheetSeq = 0;

/**
 * Mount ONCE, at the app root, after everything a sheet must cover.
 *
 * Its zIndex is above the player (30) and the drawer (45) deliberately: a sheet
 * is always the most recent thing the user asked for.
 */
export function SheetHost() {
  const list = useSyncExternalStore(
    subscribeHost,
    () => entries,
    () => entries,
  );
  return (
    <View style={styles.portal} pointerEvents="box-none">
      {list.map(e => (
        <React.Fragment key={e.id}>{e.node}</React.Fragment>
      ))}
    </View>
  );
}

/**
 * Decelerate in, accelerate out — never the default.
 *
 * Reanimated's default easing is Easing.inOut(Easing.quad), which spends the
 * first ~60ms of a 210ms slide barely moving. That slow start is precisely what
 * reads as "the sheet takes a moment to appear": the delay you feel is the
 * curve, not the work. Every platform sheet decelerates instead — off the mark
 * immediately, gentle at the end.
 */
const IN = {duration: 220, easing: Easing.out(Easing.cubic)};
const OUT = {duration: 160, easing: Easing.in(Easing.cubic)};

/** The strip at the top of a sheet where a drag is always a sheet drag. */
const HANDLE_GRAB = 44;

/**
 * "The list is at its top", with a tolerance rather than an exact zero.
 *
 * The offset is reported from JS, not from a worklet, so the last value
 * delivered before a fling comes to rest can be a sub-pixel remainder rather
 * than a clean 0. Compared exactly, that leaves the sheet permanently
 * undraggable over its own list — it could only be moved by the handle. Four
 * pixels is inside the distance the list could scroll anyway, so nothing is
 * taken from it.
 */
const AT_TOP = 4;

/**
 * How far down before the sheet takes the gesture. Only ever consulted when
 * the list is already at its top and therefore has nothing to scroll, so the
 * distance is buying nothing but delay; it exists to separate a pull from a
 * tap, and six pixels does that.
 */
const HANDOFF_DY = 6;

/** How far down you have to drag (or how fast you have to flick) to dismiss. */
const DISMISS_DISTANCE = 90;
const DISMISS_VELOCITY = 800;

export function Sheet({
  open,
  onClose,
  children,
  style,
  dragEnabled = true,
  scrollY,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Extra styling for the sheet body — height caps, mostly. */
  style?: ViewStyle;
  /**
   * Turn the drag-to-dismiss off while something inside owns the vertical
   * axis — a lifted, reorderable row, specifically.
   *
   * This gesture activates at HANDOFF_DY of downward travel, which is now
   * BELOW DraggableFlatList's activationDistance of 12 — so the sheet would
   * win outright, and it has no business winning against a row somebody is
   * holding. Whoever holds the row says so.
   */
  dragEnabled?: boolean;
  /**
   * The scroll offset of the sheet's own list, if it has one. 0 means "already
   * at the top".
   *
   * Handing it over is what makes this a scroll-aware sheet instead of a sheet
   * that fights its own content. Without it the pan claimed any 12px downward
   * drag anywhere on the sheet, and the two lists failed in opposite
   * directions: a plain FlatList has no RNGH gesture to arbitrate with, so the
   * sheet always won and scrolling up moved the sheet; DraggableFlatList is
   * RNGH-native and always won, so the sheet could only be dragged by its
   * header. With it, the list scrolls until it reaches its top, and only then
   * does further downward travel move the sheet.
   */
  scrollY?: SharedValue<number>;
}) {
  // The live window, not a module-load snapshot: a fold opening or a rotation
  // changes it, and a stale "gone" position leaves the sheet parked halfway up
  // the screen.
  const {width, height} = useWindowDimensions();
  const HIDE_Y = Math.max(width, height);

  const id = useRef(0);
  if (!id.current) {
    id.current = ++sheetSeq;
  }

  const y = useSharedValue(HIDE_Y);
  /**
   * Mounted from the first open, and never unmounted again.
   *
   * `setPresent(true)` and the slide used to start in the same effect: the
   * timing began on the UI thread immediately, but the sheet's subtree — header
   * artwork, rows, a ScrollView — was not committed until React finished the
   * render pass, so the animation was already partway through by the time there
   * was anything to see. That is the "pop" at the start of every open.
   *
   * A parked sheet is one off-screen view; keeping it costs less than rebuilding
   * it every single time. After the first open, opening is a pure UI-thread
   * translate on views that already exist, with no JS in the critical path.
   */
  const [present, setPresent] = useState(open);
  useEffect(() => {
    if (open) {
      setPresent(true);
      // A sheet that has just opened has its list at the top, by definition.
      // Saying so here rather than at each call site matters because the sheet
      // is never unmounted (see above), so the offset from the LAST time it was
      // open is still sitting in the shared value — and if that was a
      // scrolled-away position, the sheet opens undraggable over its own list.
      if (scrollY) {
        scrollY.value = 0;
      }
    }
  }, [open, scrollY]);

  useEffect(() => {
    if (!present) {
      return;
    }
    y.value = withTiming(open ? 0 : HIDE_Y, open ? IN : OUT);
  }, [open, present, y, HIDE_Y]);

  /**
   * The sheet's own height, so the scrim can fade over the distance the sheet
   * actually travels. Interpolating over the full screen left the dim at ~50%
   * when the sheet was already gone, which is why the screen stayed darkened
   * for a beat after a dismiss.
   */
  const sheetH = useSharedValue(HIDE_Y);
  const onSheetLayout = useCallback(
    (e: LayoutChangeEvent) => {
      sheetH.value = Math.max(1, e.nativeEvent.layout.height);
    },
    [sheetH],
  );

  // Gesture bookkeeping. startX/startY are the touch's origin (manual
  // activation gets touches, not translations); onHandle remembers whether this
  // drag began on the handle; engagedAt is -1 until the sheet takes over.
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const onHandle = useSharedValue(false);
  const engagedAt = useSharedValue(-1);

  // Hardware back dismisses the sheet before anything behind it sees the press.
  useEffect(() => {
    if (!open) {
      return;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [open, onClose]);

  const close = useCallback(() => onClose(), [onClose]);

  // Drag the sheet down to dismiss. Recognised natively, so it wins against
  // anything scrollable inside the sheet only when the drag is clearly vertical
  // and downward.
  const drag = Gesture.Pan()
    .enabled(dragEnabled)
    // Manual only when there is a list to defer to. Whether a downward drag
    // belongs to the sheet or to the list depends on where the list IS, not on
    // the direction of the first twelve pixels — which is the one thing an
    // activeOffset can express. Sheets with no scrollable keep the plain
    // recognition they have always had.
    .manualActivation(!!scrollY)
    .activeOffsetY([-1000, 12])
    .failOffsetX([-20, 20])
    .onTouchesDown(e => {
      const t = e.allTouches[0];
      if (!t) {
        return;
      }
      startX.value = t.absoluteX;
      startY.value = t.absoluteY;
      // The handle always drags, wherever the list happens to be scrolled to.
      // Grabbing the handle is an unambiguous statement about the sheet.
      onHandle.value = t.absoluteY < height - sheetH.value + HANDLE_GRAB;
    })
    .onTouchesMove((e, state) => {
      if (!scrollY) {
        return; // not manual — RNGH recognises this one itself
      }
      const t = e.allTouches[0];
      if (!t) {
        return;
      }
      const dx = t.absoluteX - startX.value;
      const dy = t.absoluteY - startY.value;
      if (Math.abs(dx) > 20 && Math.abs(dx) > Math.abs(dy)) {
        state.fail();
      } else if (dy > HANDOFF_DY && (onHandle.value || scrollY.value <= AT_TOP)) {
        state.activate();
      }
    })
    .onUpdate(e => {
      // Where in this gesture the sheet took over, so it moves one-to-one with
      // the finger from THERE. Without it the sheet would jump down by however
      // far the list had already scrolled at the moment it handed over.
      if (engagedAt.value < 0) {
        engagedAt.value = e.translationY;
      }
      y.value = Math.max(0, e.translationY - engagedAt.value);
    })
    .onEnd(e => {
      const travelled = e.translationY - Math.max(0, engagedAt.value);
      engagedAt.value = -1;
      if (travelled > DISMISS_DISTANCE || e.velocityY > DISMISS_VELOCITY) {
        y.value = withTiming(HIDE_Y, OUT, finished => {
          if (finished) {
            runOnJS(close)();
          }
        });
      } else {
        y.value = withTiming(0, IN);
      }
    })
    .onFinalize(() => {
      engagedAt.value = -1;
    });

  const sheetStyle = useAnimatedStyle(() => ({
    // No identity transform on a settled sheet — see the note in PlayerScreen.
    transform: y.value === 0 ? [] : [{translateY: y.value}],
  }));
  // One value drives both, so the dim and the slide can never disagree
  // mid-gesture.
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(y.value, [0, sheetH.value], [1, 0], 'clamp'),
  }));

  const tree = !present ? null : (
    // 'none' while closed, because the host is no longer unmounted between
    // opens — a parked sheet must not sit in front of the app eating touches.
    <View style={styles.host} pointerEvents={open ? 'box-none' : 'none'}>
      <Animated.View style={[styles.scrim, scrimStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
      </Animated.View>

      <GestureDetector gesture={drag}>
        <Animated.View
          style={[styles.sheet, style, sheetStyle]}
          onLayout={onSheetLayout}>
          <View style={styles.handle} />
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  );

  // Published on EVERY render — the tree contains this sheet's own children,
  // which change whenever the owner re-renders. No dependency array, on
  // purpose.
  useEffect(() => {
    publish(id.current, tree);
  });

  // And withdrawn when the owner goes away, so a screen that unmounts with its
  // menu open cannot leave the menu behind.
  useEffect(() => {
    const mine = id.current;
    return () => unpublish(mine);
  }, []);

  return null;
}

const styles = StyleSheet.create({
  // Above the full player (30) and below the drawer (45).
  //
  // It has to beat the player specifically: "Add to playlist" is raised from
  // the ⊕ inside the player, so a sheet that lost to it mounted, animated, and
  // was invisible until the player was minimised. That used to be impossible to
  // fix with zIndex at all, because the player was a Dialog window in a
  // different hierarchy — see the note at the top of PlayerScreen's render.
  host: {...StyleSheet.absoluteFillObject, zIndex: 40},
  // The layer every sheet is actually drawn in. Above the player (30), the
  // drawer (45) and the floating bars (which have none), below the toaster.
  portal: {...StyleSheet.absoluteFillObject, zIndex: 50},
  scrim: {...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)'},
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '78%',
    backgroundColor: C.surfaceHi,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 26,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    marginTop: 8,
    // A comfortable grab area for the drag, without moving the bar itself.
    marginBottom: 2,
  },
});

export const sheetGutter = S.gutter;
