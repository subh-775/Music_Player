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
import {ChevronLeft, ChevronRight} from 'lucide-react-native';
import {C} from '../theme';
import {readSettings} from '../store';

export function SeekPeek({
  side,
  seconds,
}: {
  side: 1 | -1;
  seconds: number;
}) {
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
    if (readSettings().reduceAnimations) {
      chevrons.forEach(c => c.setValue(1)); // static arrows, no chase loop
      return;
    }
    // One continuous chase, looping for as long as the disc is up.
    const loop = Animated.loop(
      Animated.stagger(
        140,
        chevrons.map(c =>
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
  }, [chevrons]);

  const Chevron = side === 1 ? ChevronRight : ChevronLeft;

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
          <Animated.View key={i} style={{opacity: c.interpolate({inputRange: [0, 1], outputRange: [0.35, 1]})}}>
            <Chevron size={22} color={C.text} strokeWidth={2.6} />
          </Animated.View>
        ))}
      </View>
      <Text style={styles.label}>
        {side === 1 ? '+' : '−'}
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
  row: {flexDirection: 'row', alignItems: 'center', marginLeft: -6},
  label: {color: C.text, fontSize: 13, fontWeight: '600', marginTop: 6},
});
