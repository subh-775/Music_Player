/**
 * Double-tap seek feedback, YouTube-style.
 *
 * The half-disc blooms in ONCE when the gesture starts and then holds steady —
 * extra taps only bump the number (10 → 20 → 30). It does NOT replay the bloom
 * on every tap, which read as a flicker. The three chevrons run a continuous
 * loop while it's up, so the motion is calm and constant rather than restarting
 * under the finger. It fades out only when the gesture ends (the component
 * unmounts).
 */
import React, {useEffect, useRef} from 'react';
import {Animated, Easing, StyleSheet, Text, View} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import {C} from '../theme';

/**
 * One solid seek triangle.
 *
 * NOT a lucide chevron. Chevrons are stroked OPEN paths (`>`), so they can't be
 * filled — which is why the mark read as three thin outlines instead of the
 * heavy solid `◀◀◀` the reference has. A closed path with `fill` is the only
 * way to get that, and react-native-svg is already a dependency.
 *
 * `side` 1 = forward (points right), -1 = back.
 */
function SeekTriangle({
  side,
  size = 21,
  color = C.text,
}: {
  side: 1 | -1;
  size?: number;
  color?: string;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={side === 1 ? undefined : styles.mirror}>
      <Path d="M5 4.2 L5 19.8 L19 12 Z" fill={color} />
    </Svg>
  );
}

export function SeekPeek({side, seconds}: {side: 1 | -1; seconds: number}) {
  // Presence: blooms in on mount, holds at 1. Only `side` re-arms it, because a
  // tap on the OTHER edge is a genuinely new gesture; a bigger number is not.
  const bloom = useRef(new Animated.Value(0)).current;
  const chevrons = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;

  useEffect(() => {
    Animated.timing(bloom, {
      toValue: 1,
      duration: 140,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [side, bloom]);

  useEffect(() => {
    // One continuous chase, looping for as long as the disc is up.
    //
    // The order FLIPS with direction. Animated.stagger always runs the array
    // left-to-right, so a fixed order chased rightward even when seeking
    // backward — the animation pointed one way and ran the other. Reversed for
    // `side === -1`, both directions now chase outward, away from the artwork.
    const order = side === 1 ? chevrons : [...chevrons].reverse();
    const loop = Animated.loop(
      Animated.stagger(
        140,
        order.map(c =>
          Animated.sequence([
            Animated.timing(c, {
              toValue: 1,
              duration: 260,
              easing: Easing.out(Easing.cubic),
              useNativeDriver: true,
            }),
            Animated.timing(c, {
              toValue: 0,
              duration: 260,
              easing: Easing.in(Easing.quad),
              useNativeDriver: true,
            }),
          ]),
        ),
      ),
    );
    loop.start();
    return () => loop.stop();
  }, [chevrons, side]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.wrap,
        side === 1 ? styles.right : styles.left,
        {
          opacity: bloom,
          transform: [
            {
              scale: bloom.interpolate({
                inputRange: [0, 1],
                outputRange: [0.9, 1],
              }),
            },
          ],
        },
      ]}>
      <View style={styles.row}>
        {chevrons.map((c, i) => (
          <Animated.View
            key={i}
            style={[
              // Each triangle overlaps the one before it, which is what makes
              // the three read as a single heavy mark rather than three
              // separate icons. A single margin on the container did not.
              i === 0 ? null : styles.overlap,
              {
                opacity: c.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.3, 1],
                }),
                transform: [
                  {
                    scale: c.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.92, 1],
                    }),
                  },
                ],
              },
            ]}>
            <SeekTriangle side={side} />
          </Animated.View>
        ))}
      </View>
      {/* ASCII '+' and '-'. The label used U+2212 (true minus) against an ASCII
          plus; they render at different widths, so the whole text block shifted
          sideways between forward and backward. */}
      <Text style={styles.label}>
        {side === 1 ? '+' : '-'}
        {seconds} seconds
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '48%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.13)',
  },
  left: {
    left: 0,
    borderTopRightRadius: 999,
    borderBottomRightRadius: 999,
  },
  right: {
    right: 0,
    borderTopLeftRadius: 999,
    borderBottomLeftRadius: 999,
  },
  mirror: {transform: [{scaleX: -1}]},
  row: {flexDirection: 'row', alignItems: 'center'},
  overlap: {marginLeft: -7},
  label: {color: C.text, fontSize: 13, fontWeight: '600', marginTop: 6},
});
