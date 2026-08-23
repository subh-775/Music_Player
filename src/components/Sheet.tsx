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
  type ViewStyle,
} from 'react-native';
import {Gesture, GestureDetector} from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {C, S} from '../theme';

const SCREEN_H = Dimensions.get('window').height;

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
  const y = useSharedValue(SCREEN_H);
  // Stays true through the close animation, so the sheet doesn't blank out
  // while it is still sliding away.
  const [present, setPresent] = useState(open);

  useEffect(() => {
    if (open) {
      setPresent(true);
      y.value = withTiming(0, {duration: 210});
    } else {
      y.value = withTiming(SCREEN_H, {duration: 170}, finished => {
        if (finished) {
          runOnJS(setPresent)(false);
        }
      });
    }
  }, [open, y]);

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
        y.value = withTiming(SCREEN_H, {duration: 170}, finished => {
          if (finished) {
            runOnJS(close)();
          }
        });
      } else {
        y.value = withTiming(0, {duration: 170});
      }
    });

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{translateY: y.value}],
  }));
  // One value drives both, so the dim and the slide can never disagree
  // mid-gesture.
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(y.value, [0, SCREEN_H], [1, 0]),
  }));

  if (!present) {
    return null;
  }

  return (
    <View style={styles.host} pointerEvents="box-none">
      <Animated.View style={[styles.scrim, scrimStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
      </Animated.View>

      <GestureDetector gesture={drag}>
        <Animated.View style={[styles.sheet, style, sheetStyle]}>
          <View style={styles.handle} />
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  // Above the screen overlays (which counter up from 1) and below the drawer.
  host: {...StyleSheet.absoluteFillObject, zIndex: 30},
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
