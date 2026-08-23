/**
 * A draggable seek bar.
 *
 * The fill and thumb are driven by an Animated.Value updated straight from the
 * gesture — no React re-render per frame, so the scrub is smooth even under a
 * busy JS thread. Seeking only happens on release (one Range request, not one
 * per pixel), and the released position is HELD until the engine's own progress
 * catches up, so the thumb never snaps back to the old spot for a frame.
 *
 * The time label updates on whole-second changes only — cheap, and all the eye
 * needs while scrubbing.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  Animated,
  PanResponder,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
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

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function Seekbar({
  position,
  duration,
  onSeek,
}: {
  position: number;
  duration: number;
  onSeek: (seconds: number) => void;
}) {
  const t = useRef(new Animated.Value(0)).current;
  const [label, setLabel] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  // Grow, don't recolor. Swapping the thumb's fill white -> accent green (and
  // back) landed in a single frame each way — a hard color flip reads as a
  // glitch. Size is what says "this is now grabbed"; the colour never moves.
  const grow = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(grow, {
      toValue: scrubbing ? 1 : 0,
      duration: scrubbing ? 120 : 180,
      // NATIVE. This used to animate width/height/borderRadius, which the
      // driver cannot handle — so the grab animation ran on the JS thread, at
      // precisely the moment the JS thread is busiest (you are mid-scrub). It
      // is a `scale` on a fixed-size thumb now, which the driver can.
      useNativeDriver: true,
    }).start();
  }, [scrubbing, grow]);

  const widthRef = useRef(0);
  const durationRef = useRef(0);
  durationRef.current = duration;
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
    const frac = duration > 0 ? clamp01(position / duration) : 0;
    t.setValue(frac);
    setLabel(position);
  }, [position, duration, t]);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    widthRef.current = Math.max(1, e.nativeEvent.layout.width);
  }, []);

  const apply = useCallback(
    (x: number) => {
      const frac = clamp01(x / widthRef.current);
      t.setValue(frac);
      const secs = frac * (durationRef.current || 0);
      setLabel(prev => (Math.floor(prev) === Math.floor(secs) ? prev : secs));
      return secs;
    },
    [t],
  );

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: e => {
        draggingRef.current = true;
        setScrubbing(true);
        apply(e.nativeEvent.locationX);
      },
      onPanResponderMove: e => apply(e.nativeEvent.locationX),
      onPanResponderRelease: e => {
        const secs = apply(e.nativeEvent.locationX);
        draggingRef.current = false;
        setScrubbing(false);
        heldRef.current = secs;
        onSeekRef.current(secs);
        // Failsafe: never pin the thumb forever if the seek never lands.
        setTimeout(() => {
          heldRef.current = null;
        }, 2500);
      },
      onPanResponderTerminate: () => {
        draggingRef.current = false;
        setScrubbing(false);
      },
    }),
  ).current;

  const widthPct = t.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <View style={styles.wrap}>
      {/* ~28px visual, 44px touch (Fitts') — a 4px bar is unhittable. */}
      <View style={styles.touch} onLayout={onLayout} {...pan.panHandlers}>
        <View style={styles.track}>
          <Animated.View style={[styles.fill, {width: widthPct}]} />
        </View>
        {/* Two nodes on purpose: the OUTER one is positioned with a percentage
            `left`, which only the JS driver can animate, and the INNER one
            scales natively. Putting both on one node makes React Native refuse
            the native driver outright. */}
        <Animated.View
          style={[styles.thumbAnchor, {left: widthPct}]}
          pointerEvents="none">
          <Animated.View
            style={[
              styles.thumb,
              {
                transform: [
                  {
                    scale: grow.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1, 1.32],
                    }),
                  },
                ],
              },
            ]}
          />
        </Animated.View>
      </View>
      <View style={styles.times}>
        <Text style={styles.time}>{clock(label)}</Text>
        <Text style={styles.time}>{clock(duration)}</Text>
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
  // Half the thumb's width, so the thumb sits centred on the playhead.
  thumbAnchor: {position: 'absolute', marginLeft: -6.5},
  thumb: {
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
  times: {flexDirection: 'row', justifyContent: 'space-between', marginTop: 6},
  time: {color: C.sub, fontSize: 11, fontVariant: ['tabular-nums']},
});
