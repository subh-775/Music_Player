/**
 * A grab-and-drag scroll thumb for long lists — the white pill with up/down
 * chevrons at the right edge, the way Spotify's library does it.
 *
 * Appears while the list is moving and fades after it stops. Drag it and the
 * list follows proportionally, so the far end of a long library is one thumb
 * movement away instead of a dozen flings. Only offered when there is enough
 * list to need it (over two and a half screens): on a short list a scroll
 * thumb is just something sitting on top of the rows.
 *
 * Everything runs on the UI thread — the scroll offset arrives in a worklet
 * scroll handler and the drag writes back with Reanimated's scrollTo — so a
 * busy JS thread cannot make the thumb trail the finger. JS hears about it
 * exactly twice per scroll session, when the thumb becomes touchable and when
 * it stops being so.
 */
import React, {useState} from 'react';
import {StyleSheet, View} from 'react-native';
import {Gesture, GestureDetector} from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  scrollTo,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  type AnimatedRef,
  type SharedValue,
} from 'react-native-reanimated';
import {ChevronDown, ChevronUp} from 'lucide-react-native';

const THUMB = 46;
/** Breathing room above and below the thumb's travel. */
const EDGE = 8;
/** How long the thumb stays after the list stops. */
const HIDE_AFTER_MS = 1300;
/** The list must be this many screens longer than the window to get a thumb. */
const WORTH_SCREENS = 1.5;

type FastScrollState = {
  scrollY: SharedValue<number>;
  contentH: SharedValue<number>;
  viewH: SharedValue<number>;
  shown: SharedValue<number>;
  dragging: SharedValue<boolean>;
};

/** The list's side: a scroll handler to hand the list, and the state the
 *  thumb reads. */
export function useFastScroll() {
  const scrollY = useSharedValue(0);
  const contentH = useSharedValue(0);
  const viewH = useSharedValue(0);
  const shown = useSharedValue(0);
  const dragging = useSharedValue(false);

  const onScroll = useAnimatedScrollHandler(e => {
    scrollY.value = e.contentOffset.y;
    // The event carries both sizes, so no onLayout / onContentSizeChange —
    // and before the first scroll the thumb is hidden anyway.
    contentH.value = e.contentSize.height;
    viewH.value = e.layoutMeasurement.height;
    if (!dragging.value) {
      // FULL at once, on the first scroll event in either direction — no
      // fade-in. A fade (and the slide that went with it) meant the thumb
      // arrived grey and half-there, and became grabbable only once it had
      // finished growing. Restarted on every event, so it goes away
      // HIDE_AFTER_MS after the LAST one; withDelay holds it at 1 until then.
      shown.value = 1;
      shown.value = withDelay(HIDE_AFTER_MS, withTiming(0, {duration: 260}));
    }
  });

  const state: FastScrollState = {scrollY, contentH, viewH, shown, dragging};
  return {onScroll, state};
}

/** Where the thumb's travel starts and how long it is, for a window this tall. */
function trackLength(viewH: number, bottomInset: number): number {
  'worklet';
  return Math.max(1, viewH - bottomInset - THUMB - EDGE * 2);
}

export function FastScroll({
  listRef,
  state,
  bottomInset = 0,
}: {
  /** Any scrollable — a FlatList here, but scrollTo takes them all. */
  listRef: AnimatedRef<any>;
  state: FastScrollState;
  /** The part of the window the floating bars cover; the thumb stops above it. */
  bottomInset?: number;
}) {
  const {scrollY, contentH, viewH, shown, dragging} = state;
  const dragTop = useSharedValue(0);
  const startTop = useSharedValue(0);
  // Touchable only while visible — an invisible thumb must not eat taps on the
  // rows under it.
  const [live, setLive] = useState(false);

  useAnimatedReaction(
    () =>
      shown.value > 0.5 &&
      contentH.value - viewH.value > viewH.value * WORTH_SCREENS,
    (on, prev) => {
      if (on !== prev) {
        runOnJS(setLive)(on);
      }
    },
  );

  const thumbStyle = useAnimatedStyle(() => {
    const vh = viewH.value;
    const max = Math.max(0, contentH.value - vh);
    const len = trackLength(vh, bottomInset);
    const top = dragging.value
      ? dragTop.value
      : max > 0
      ? (scrollY.value / max) * len
      : 0;
    const worth = max > vh * WORTH_SCREENS;
    return {
      opacity: worth ? shown.value : 0,
      transform: [{translateY: EDGE + Math.min(len, Math.max(0, top))}],
    };
  });

  const drag = Gesture.Pan()
    .minDistance(0)
    .hitSlop({left: 18, top: 10, bottom: 10})
    .onStart(() => {
      const vh = viewH.value;
      const max = Math.max(0, contentH.value - vh);
      const len = trackLength(vh, bottomInset);
      const top = max > 0 ? (scrollY.value / max) * len : 0;
      startTop.value = top;
      dragTop.value = top;
      dragging.value = true;
      shown.value = 1;
    })
    .onUpdate(e => {
      const vh = viewH.value;
      const max = Math.max(0, contentH.value - vh);
      const len = trackLength(vh, bottomInset);
      const top = Math.min(len, Math.max(0, startTop.value + e.translationY));
      dragTop.value = top;
      scrollTo(listRef, 0, (top / len) * max, false);
    })
    .onFinalize(() => {
      dragging.value = false;
      shown.value = withDelay(HIDE_AFTER_MS, withTiming(0, {duration: 260}));
    });

  return (
    <GestureDetector gesture={drag}>
      <Animated.View
        style={[styles.thumb, thumbStyle]}
        pointerEvents={live ? 'auto' : 'none'}>
        <View style={styles.glyphs} pointerEvents="none">
          <ChevronUp size={17} color={GLYPH} strokeWidth={2.6} />
          <ChevronDown size={17} color={GLYPH} strokeWidth={2.6} />
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

const GLYPH = '#6b6b6b';

const styles = StyleSheet.create({
  // Pinned top-right and moved with a transform, so the travel never costs a
  // layout pass. Hangs a third off the edge, as the reference does — the part
  // under the thumb is the part that matters.
  thumb: {
    position: 'absolute',
    top: 0,
    right: -14,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: '#f4f4f4',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: {width: 0, height: 2},
  },
  // Nudged toward the visible side of the circle.
  glyphs: {marginRight: 12, marginTop: -1},
});
