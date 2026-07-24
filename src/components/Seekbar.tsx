/**
 * A draggable seek bar.
 *
 * The position is held locally WHILE dragging and only committed on release.
 * Seeking on every movement event would fire a Range request against
 * /api/proxy_stream for each pixel the thumb travels, which stalls the stream
 * you're trying to scrub through.
 *
 * While a drag is in flight the incoming `position` prop is ignored — otherwise
 * the engine's own progress ticks would yank the thumb out from under the
 * finger every half-second.
 */
import React, {useCallback, useMemo, useRef, useState} from 'react';
import {
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

export function Seekbar({
  position,
  duration,
  onSeek,
}: {
  position: number;
  duration: number;
  onSeek: (seconds: number) => void;
}) {
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);
  // After release the engine takes a beat to report the new position; keep
  // showing the released value until it catches up, or the thumb snaps back
  // to the OLD position for a flash on every scrub.
  const [held, setHeld] = useState<number | null>(null);

  // Refs so the PanResponder — created once — always reads current values
  // instead of closing over the first render's.
  const widthRef = useRef(0);
  const durationRef = useRef(0);
  widthRef.current = width;
  durationRef.current = duration;

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width);
  }, []);

  const seconds = useCallback((x: number) => {
    const w = widthRef.current;
    const d = durationRef.current;
    if (w <= 0 || d <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(d, (x / w) * d));
  }, []);

  const pan = useMemo(
    () =>
      PanResponder.create({
        // Claim on touch-down: this whole strip is the control, so a tap
        // anywhere on it should scrub, not just a drag from the thumb.
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: e => {
          setDragging(seconds(e.nativeEvent.locationX));
        },
        onPanResponderMove: e => {
          // locationX is relative to this view and can run past either end once
          // the finger leaves it; seconds() clamps, so dragging off the edge
          // pins to 0:00 / the full duration rather than jumping.
          setDragging(seconds(e.nativeEvent.locationX));
        },
        onPanResponderRelease: e => {
          const target = seconds(e.nativeEvent.locationX);
          setHeld(target);
          onSeek(target);
          setDragging(null);
          // Failsafe: if the seek never lands (engine error), don't pin the
          // thumb to a position the audio isn't at.
          setTimeout(() => setHeld(null), 2500);
        },
        onPanResponderTerminate: () => setDragging(null),
      }),
    [seconds, onSeek],
  );

  // Release the hold once the engine's reported position reaches the seek
  // target (within a tick), or after it has clearly moved on.
  if (held !== null && Math.abs(position - held) < 1.5) {
    setHeld(null);
  }

  const shown = dragging ?? held ?? position;
  const pct = duration > 0 ? Math.max(0, Math.min(1, shown / duration)) : 0;

  return (
    <View style={styles.wrap}>
      {/* Generous vertical padding makes the touch target ~28px tall while the
          bar still LOOKS 4px — a 4px target is unhittable with a thumb. */}
      <View style={styles.touch} onLayout={onLayout} {...pan.panHandlers}>
        <View style={styles.track}>
          <View style={[styles.fill, {width: `${pct * 100}%`}]} />
        </View>
        <View
          style={[
            styles.thumb,
            {left: `${pct * 100}%`},
            dragging !== null && styles.thumbActive,
          ]}
          pointerEvents="none"
        />
      </View>
      <View style={styles.times}>
        <Text style={styles.time}>{clock(shown)}</Text>
        <Text style={styles.time}>{clock(duration)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {marginTop: 14},
  touch: {justifyContent: 'center', height: 28},
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    overflow: 'hidden',
  },
  fill: {height: '100%', backgroundColor: C.text, borderRadius: 2},
  thumb: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
    marginLeft: -6,
    backgroundColor: C.text,
  },
  thumbActive: {
    width: 16,
    height: 16,
    borderRadius: 8,
    marginLeft: -8,
    backgroundColor: C.accentBright,
  },
  times: {flexDirection: 'row', justifyContent: 'space-between', marginTop: 4},
  time: {color: C.sub, fontSize: 11, fontVariant: ['tabular-nums']},
});
