/**
 * Playback speed, one tap from the player.
 *
 * Presets for the speeds people actually pick, and a slider for the ones they
 * do not. The range, the snapping and the labelling live in src/playbackRate.ts
 * — none of that is about drawing anything, and the player's own button needs
 * the same answers this sheet does.
 *
 * The speed is a property of LISTENING, not of a song, so it carries across
 * tracks — see applyPlaybackRate. ExoPlayer pitch-corrects, so 1.5x is faster
 * and not higher, which is the only reason this is usable on music at all.
 *
 * Same drag machinery as the crossfade bar and the equalizer bands: the fill is
 * a shared value written straight from the gesture worklet, so it tracks the
 * finger on the UI thread, and the readout crosses to JS only when the
 * displayed value actually changes rather than on every frame.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {Gesture, GestureDetector} from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {Gauge, Minus, Plus} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {Sheet} from './Sheet';
import {playbackRate, setPlaybackRate} from '../player';
import {
  RATE_MAX,
  RATE_MIN,
  RATE_PRESETS,
  RATE_STEP,
  clampRate,
  fracOf,
  isRate,
  rateAt,
  rateLabel,
} from '../playbackRate';
import {useSettings} from '../store';

export function SpeedSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const {playbackRate: stored} = useSettings();
  const rate = clampRate(stored);

  const t = useSharedValue(fracOf(rate));
  /** The track's measured width, so the worklet never has to ask JS. */
  const w = useSharedValue(1);
  /** 0 at rest, 1 while held — the thumb grows under the finger. */
  const grow = useSharedValue(0);
  const [shown, setShown] = useState(rate);
  const dragging = useRef(false);

  // Follow the setting when it changes from OUTSIDE a drag — a preset tap, a
  // +/- press, or Settings being reset while this is open.
  useEffect(() => {
    if (!dragging.current) {
      t.value = withTiming(fracOf(rate), {duration: 140});
      setShown(rate);
    }
  }, [rate, t]);

  const commit = useCallback((next: number) => {
    setPlaybackRate(next).catch(() => {});
  }, []);

  const settle = useCallback(
    (next: number) => {
      dragging.current = false;
      commit(next);
    },
    [commit],
  );

  const drag = useRef(
    Gesture.Pan()
      .activeOffsetX([-6, 6])
      .failOffsetY([-14, 14])
      .onBegin(e => {
        grow.value = withTiming(1, {duration: 110});
        t.value = Math.min(1, Math.max(0, e.x / w.value));
        runOnJS(setShown)(rateAt(t.value));
        dragging.current = true;
      })
      .onUpdate(e => {
        const next = Math.min(1, Math.max(0, e.x / w.value));
        const was = rateAt(t.value);
        t.value = next;
        // JS hears about it only when the SNAPPED value changes — roughly
        // thirty crossings across the whole bar instead of one per frame.
        if (rateAt(next) !== was) {
          runOnJS(setShown)(rateAt(next));
        }
      })
      .onFinalize(() => {
        grow.value = withTiming(0, {duration: 160});
        const landed = rateAt(t.value);
        // Snap the fill to the value that actually committed, so the bar and
        // the number can never disagree once the finger lifts.
        t.value = withTiming(fracOf(landed), {duration: 90});
        runOnJS(settle)(landed);
      }),
  ).current;

  const fill = useAnimatedStyle(() => ({width: `${t.value * 100}%`}));
  const thumb = useAnimatedStyle(() => ({
    left: `${t.value * 100}%`,
    transform: [{translateX: -9}, {scale: 1 + grow.value * 0.25}],
  }));

  const nudge = useCallback(
    (delta: number) => commit(clampRate(playbackRate() + delta)),
    [commit],
  );

  return (
    <Sheet open={open} onClose={onClose}>
      <View style={styles.head}>
        <Gauge size={19} color={C.accent} />
        <View style={styles.headText}>
          <Text style={styles.title}>Playback speed</Text>
          <Text style={styles.sub}>
            {isRate(rate, 1) ? 'Normal' : 'Kept for the songs after this one'}
          </Text>
        </View>
      </View>

      <Text style={styles.value}>{rateLabel(shown)}</Text>

      <View style={styles.sliderRow}>
        <TouchableOpacity
          onPress={() => nudge(-RATE_STEP)}
          disabled={rate <= RATE_MIN}
          hitSlop={10}
          style={[styles.round, rate <= RATE_MIN && styles.roundOff]}
          accessibilityRole="button"
          accessibilityLabel="Slower">
          <Minus size={20} color={rate <= RATE_MIN ? C.faint : C.text} />
        </TouchableOpacity>

        <GestureDetector gesture={drag}>
          <View
            style={styles.touch}
            onLayout={e => {
              w.value = e.nativeEvent.layout.width;
            }}>
            <View style={styles.track}>
              <Animated.View style={[styles.trackFill, fill]} />
            </View>
            <Animated.View style={[styles.thumb, thumb]} />
          </View>
        </GestureDetector>

        <TouchableOpacity
          onPress={() => nudge(RATE_STEP)}
          disabled={rate >= RATE_MAX}
          hitSlop={10}
          style={[styles.round, rate >= RATE_MAX && styles.roundOff]}
          accessibilityRole="button"
          accessibilityLabel="Faster">
          <Plus size={20} color={rate >= RATE_MAX ? C.faint : C.text} />
        </TouchableOpacity>
      </View>

      <View style={styles.presets}>
        {RATE_PRESETS.map(p => {
          const on = isRate(rate, p);
          return (
            <TouchableOpacity
              key={p}
              onPress={() => commit(p)}
              activeOpacity={0.8}
              style={[styles.chip, on && styles.chipOn]}>
              <Text style={[styles.chipText, on && styles.chipTextOn]}>
                {p.toFixed(p === Math.round(p) ? 1 : 2)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

    </Sheet>
  );
}

const THUMB = 18;

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: S.gutter,
    paddingTop: 14,
    paddingBottom: 2,
  },
  headText: {flex: 1, minWidth: 0},
  title: {...T.rowTitle, color: C.text, fontSize: 16},
  sub: {...T.sub, color: C.sub, marginTop: 1},
  value: {
    ...T.screenTitle,
    color: C.text,
    fontSize: 30,
    textAlign: 'center',
    paddingTop: 6,
    paddingBottom: 14,
  },
  sliderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: S.gutter,
  },
  round: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.surfaceHi,
  },
  roundOff: {opacity: 0.45},
  // A tall touch area around a thin bar: the bar is 4px and a 4px target is
  // not a target. Same trick the crossfade bar and the EQ bands use.
  touch: {flex: 1, height: 44, justifyContent: 'center'},
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.16)',
    overflow: 'hidden',
  },
  trackFill: {height: '100%', backgroundColor: C.text},
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: C.text,
  },
  presets: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: S.gutter,
    paddingTop: 20,
    paddingBottom: 6,
  },
  chip: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 999,
    alignItems: 'center',
    backgroundColor: C.surfaceHi,
  },
  chipOn: {backgroundColor: C.accent},
  chipText: {...T.body, color: C.text},
  chipTextOn: {color: '#000', fontWeight: '800'},
});
