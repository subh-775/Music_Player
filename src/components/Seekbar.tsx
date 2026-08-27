/**
 * A draggable seek bar.
 *
 * The fill and thumb are driven by ONE shared value written straight from the
 * gesture on the UI thread — no React re-render per frame and no bridge crossing
 * per frame, so the scrub is smooth even while the JS thread is busy. Seeking
 * happens on release (one Range request, not one per pixel), and the released
 * position is HELD until the engine's own progress catches up, so the thumb
 * never snaps back to the old spot for a frame.
 *
 * ## Why this is not a PanResponder
 *
 * It was, with `onStartShouldSetPanResponder: () => true` — which claimed EVERY
 * touch landing anywhere in the 44px strip, including one that was the start of
 * a downward drag meant to minimise the player. Once the JS responder system has
 * granted a touch there is no handing it back, so that drag simply died. This is
 * the most-touched control in the app and it sat in the middle of a sheet with
 * its own dismiss gesture.
 *
 * A tap and a scrub are now two declarations that race natively: `failOffsetY`
 * lets a clearly-vertical drag fall through to the player's dismiss, while a
 * horizontal one still takes the bar immediately.
 *
 * The time label updates on whole-second changes only — cheap, and all the eye
 * needs while scrubbing. It is the only thing here that touches JS mid-drag, at
 * most once a second.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {StyleSheet, Text, View, type LayoutChangeEvent} from 'react-native';
import {Gesture, GestureDetector} from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {C} from '../theme';

function clock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) {
    return '0:00';
  }
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/** How long a tap on the bar may last before it counts as a press, not a jump. */
const TAP_MS = 400;

export function Seekbar({
  position,
  duration,
  onSeek,
}: {
  position: number;
  duration: number;
  onSeek: (seconds: number) => void;
  /**
   * Rendered BETWEEN the two timestamps. The player's pane toggles live here
   * rather than in a row of their own — three labelled tabs were a whole strip
   * of screen spent on two states.
   */
}) {
  /** 0..1 along the bar. The single source of truth for fill and thumb. */
  const t = useSharedValue(0);
  /**
   * Grow, don't recolor. Swapping the thumb's fill white → accent green (and
   * back) landed in a single frame each way — a hard colour flip reads as a
   * glitch. Size is what says "this is now grabbed"; the colour never moves.
   *
   * No React state behind it any more: a `scrubbing` boolean re-rendered this
   * component twice per drag for something the UI thread can own outright.
   */
  const grow = useSharedValue(0);

  const [label, setLabel] = useState(0);

  // Measured width and the current duration, readable from the gesture worklet.
  const barW = useSharedValue(1);
  const dur = useSharedValue(0);
  /** Last whole second handed to JS, so the label costs at most 1 crossing/sec. */
  const shownSec = useSharedValue(-1);

  useEffect(() => {
    dur.value = duration;
  }, [duration, dur]);

  const draggingRef = useRef(false);
  // Held target after release, until the engine reports it caught up.
  const heldRef = useRef<number | null>(null);
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  // Follow engine progress when not dragging and not holding a just-seeked spot.
  useEffect(() => {
    if (draggingRef.current || heldRef.current !== null) {
      if (
        heldRef.current !== null &&
        Math.abs(position - heldRef.current) < 1.5
      ) {
        heldRef.current = null; // engine caught up — resume following
      } else {
        return;
      }
    }
    const frac =
      duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0;
    t.value = frac;
    setLabel(position);
  }, [position, duration, t]);

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      barW.value = Math.max(1, e.nativeEvent.layout.width);
    },
    [barW],
  );

  const beginDrag = useCallback(() => {
    draggingRef.current = true;
  }, []);

  const cancelDrag = useCallback(() => {
    draggingRef.current = false;
  }, []);

  const commitSeek = useCallback((secs: number) => {
    draggingRef.current = false;
    heldRef.current = secs;
    setLabel(secs);
    onSeekRef.current(secs);
    // Failsafe: never pin the thumb forever if the seek never lands.
    setTimeout(() => {
      heldRef.current = null;
    }, 2500);
  }, []);

  /** Where along the bar a touch at `x` sits, 0..1. */
  const fracAt = useCallback(
    (x: number) => {
      'worklet';
      return Math.max(0, Math.min(1, x / barW.value));
    },
    [barW],
  );

  const scrub = Gesture.Pan()
    // A short horizontal move takes the bar; a vertical one falls through, which
    // is what lets a downward drag starting here dismiss the player instead of
    // dying in a responder that had already claimed it.
    .activeOffsetX([-4, 4])
    .failOffsetY([-14, 14])
    .onBegin(() => {
      runOnJS(beginDrag)();
    })
    .onStart(e => {
      grow.value = withTiming(1, {duration: 120});
      t.value = fracAt(e.x);
    })
    .onUpdate(e => {
      t.value = fracAt(e.x);
      const secs = Math.floor(t.value * dur.value);
      if (secs !== shownSec.value) {
        shownSec.value = secs;
        runOnJS(setLabel)(secs);
      }
    })
    .onEnd((e, success) => {
      if (success) {
        runOnJS(commitSeek)(fracAt(e.x) * dur.value);
      }
    })
    .onFinalize((_e, success) => {
      grow.value = withTiming(0, {duration: 180});
      if (!success) {
        // Never activated (or was cancelled) — release the follow lock that
        // onBegin took, or the bar would stop tracking the engine for good.
        runOnJS(cancelDrag)();
      }
    });

  // Tap to jump. A Pan cannot serve this without activating on touch-down, and
  // activating on touch-down is exactly the behaviour being removed.
  const jump = Gesture.Tap()
    .maxDuration(TAP_MS)
    .onEnd((e, success) => {
      if (success) {
        t.value = fracAt(e.x);
        runOnJS(commitSeek)(fracAt(e.x) * dur.value);
      }
    });

  const gesture = Gesture.Race(scrub, jump);

  const fillStyle = useAnimatedStyle(() => ({
    width: `${t.value * 100}%`,
  }));
  // One node, not two: a shared value has no native-driver restriction, so the
  // percentage `left` and the `scale` can finally live on the same view. The
  // JS-driven outer anchor that used to be required for that is gone.
  const thumbStyle = useAnimatedStyle(() => ({
    left: `${t.value * 100}%`,
    transform: [{scale: 1 + grow.value * 0.32}],
  }));

  return (
    <View style={styles.wrap}>
      {/* ~28px visual, 44px touch (Fitts') — a 4px bar is unhittable. */}
      <GestureDetector gesture={gesture}>
        <View style={styles.touch} onLayout={onLayout}>
          <View style={styles.track}>
            <Animated.View style={[styles.fill, fillStyle]} />
          </View>
          <Animated.View
            style={[styles.thumb, thumbStyle]}
            pointerEvents="none"
          />
        </View>
      </GestureDetector>
      <View style={styles.times}>
        <Text style={styles.time}>{clock(label)}</Text>
        <Text style={[styles.time, styles.timeEnd]}>{clock(duration)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {marginTop: 14},
  touch: {justifyContent: 'center', height: 44},
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    overflow: 'hidden',
  },
  fill: {height: '100%', backgroundColor: C.text, borderRadius: 2},
  thumb: {
    position: 'absolute',
    // Half the thumb's width, so it sits centred on the playhead.
    marginLeft: -6.5,
    width: 13,
    height: 13,
    borderRadius: 6.5,
    backgroundColor: C.text,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 3,
    shadowOffset: {width: 0, height: 1},
    elevation: 3,
  },
  // With the centre slot gone the row is two timestamps, so it can be a plain
  // space-between — and it is 5px under the bar rather than half a capsule
  // below it, which is what the tall centre child used to force.
  times: {flexDirection: 'row', justifyContent: 'space-between', marginTop: 2},
  time: {
    // C.text at 700 with the opacity knocked back, rather than C.sub at 400:
    // the numbers read as part of the bar instead of a caption under it, and
    // the knock-back is what stops them competing with the title above.
    color: C.text,
    opacity: 0.72,
    fontSize: 11.5,
    fontWeight: '700',
    width: 46,
    fontVariant: ['tabular-nums'],
  },
  timeEnd: {textAlign: 'right'},
});
