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
import React, {useCallback, useEffect, useState} from 'react';
import {
  BackHandler,
  Dimensions,
  Pressable,
  StyleSheet,
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
  withTiming,
} from 'react-native-reanimated';
import {C, S} from '../theme';

/**
 * How far down "gone" is. The LONGEST edge, not the height.
 *
 * Read once at module load, which is fine only because max(w, h) is the same
 * number in both orientations — a plain `height` read is not. The activity
 * handles rotation itself (configChanges lists `orientation`), so a portrait
 * height captured in landscape used to leave the sheet's closed position
 * halfway up a portrait screen, with the sheet still visible.
 */
const HIDE_Y = (({width, height}) => Math.max(width, height))(
  Dimensions.get('window'),
);

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

/** How far down you have to drag (or how fast you have to flick) to dismiss. */
const DISMISS_DISTANCE = 90;
const DISMISS_VELOCITY = 800;

export function Sheet({
  open,
  onClose,
  children,
  style,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Extra styling for the sheet body — height caps, mostly. */
  style?: ViewStyle;
}) {
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
    }
  }, [open]);

  useEffect(() => {
    if (!present) {
      return;
    }
    y.value = withTiming(open ? 0 : HIDE_Y, open ? IN : OUT);
  }, [open, present, y]);

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
    .activeOffsetY([-1000, 12])
    .failOffsetX([-20, 20])
    .onUpdate(e => {
      y.value = Math.max(0, e.translationY);
    })
    .onEnd(e => {
      if (e.translationY > DISMISS_DISTANCE || e.velocityY > DISMISS_VELOCITY) {
        y.value = withTiming(HIDE_Y, OUT, finished => {
          if (finished) {
            runOnJS(close)();
          }
        });
      } else {
        y.value = withTiming(0, IN);
      }
    });

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{translateY: y.value}],
  }));
  // One value drives both, so the dim and the slide can never disagree
  // mid-gesture.
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(y.value, [0, sheetH.value], [1, 0], 'clamp'),
  }));

  if (!present) {
    return null;
  }

  return (
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
