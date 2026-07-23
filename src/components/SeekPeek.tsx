/**
 * Double-tap seek feedback, YouTube-style.
 *
 * A soft half-disc blooms from the tapped edge and three chevrons light up ONE
 * AFTER ANOTHER, travelling in the direction you're going. The whole thing
 * fades as it leaves rather than blinking off, so a fast triple-tap reads as
 * one continuous gesture instead of three flashes.
 */
import React, {useEffect, useRef} from 'react';
import {Animated, Easing, StyleSheet, Text, View} from 'react-native';
import {ChevronLeft, ChevronRight} from 'lucide-react-native';
import {C} from '../theme';

export function SeekPeek({
  side,
  seconds,
  nonce,
}: {
  side: 1 | -1;
  seconds: number;
  /** Changes on every tap, so a repeat tap replays the animation. */
  nonce: number;
}) {
  const bloom = useRef(new Animated.Value(0)).current;
  const chevrons = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;

  useEffect(() => {
    bloom.setValue(0);
    chevrons.forEach(c => c.setValue(0));

    Animated.parallel([
      // Bloom in fast, hold, then ease out — the fade is the longest part so
      // the disc doesn't vanish mid-gesture.
      Animated.sequence([
        Animated.timing(bloom, {
          toValue: 1,
          duration: 110,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.delay(180),
        Animated.timing(bloom, {
          toValue: 0,
          duration: 320,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
      // Chevrons chase each other outward, 90ms apart.
      Animated.stagger(
        90,
        chevrons.map(c =>
          Animated.sequence([
            Animated.timing(c, {
              toValue: 1,
              duration: 150,
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
    ]).start();
  }, [nonce, bloom, chevrons]);

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
                outputRange: [0.86, 1],
              }),
            },
          ],
        },
      ]}>
      <View style={styles.row}>
        {chevrons.map((c, i) => (
          <Animated.View
            key={i}
            style={{
              opacity: c,
              transform: [
                {
                  translateX: c.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, side * 5],
                  }),
                },
              ],
            }}>
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
