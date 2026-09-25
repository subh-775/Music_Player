/**
 * "Listen up Buddy" — the header on Home.
 *
 * "Listen" and "Buddy" wear a matched pair of colours, "up" stays white. The
 * pair changes only when you arrive: each launch, and each time you come back
 * to Home from another tab. While Home is on screen it holds still — a header
 * that kept changing under you was a distraction, not a greeting.
 *
 * Pairs, not two independent random picks: every entry in PAIRS is two colours
 * chosen to sit well together on true black, so any combination looks
 * deliberate. A new visit never repeats the pair the last one showed.
 *
 * Three SIBLING Texts, each with its own weight, not one Text with nested
 * spans. The app's default font (src/font.ts) names the family on every Text;
 * on Android a nested span that names a family without a weight resets to that
 * family's REGULAR weight, which made the words thin and look like another
 * typeface.
 *
 * It blushes in on mount — a short fade and rise — so opening the app feels
 * like arriving somewhere rather than a list appearing.
 */
import React, {useEffect, useRef, useState} from 'react';
import {Animated, Easing, StyleSheet, Text, View} from 'react-native';
import {C} from '../theme';

/** [Listen, Buddy]. Each pair is complementary or split-complementary, and
 *  every colour is bright enough to read on #000. */
export const PAIRS: [string, string][] = [
  ['#FF5A5F', '#00B4FF'], // coral · sky
  ['#FF9F1C', '#B388FF'], // orange · lavender
  ['#8AE234', '#FF6FD8'], // lime · pink
  ['#2EC4B6', '#FFD23F'], // teal · sun
  ['#7B8CFF', '#FF9F1C'], // periwinkle · orange
  ['#FF6FD8', '#2EC4B6'], // pink · teal
  ['#FFD23F', '#7B8CFF'], // sun · periwinkle
  ['#00B4FF', '#8AE234'], // sky · lime
];

/**
 * The index of the next pair: any pair except the current one. Exported for
 * the test.
 */
export function nextPair(
  current: number,
  count: number = PAIRS.length,
  rand: () => number = Math.random,
): number {
  if (count < 2) {
    return 0;
  }
  if (current < 0 || current >= count) {
    return Math.floor(rand() * count); // a launch: any pair at all
  }
  // Pick among the other count-1 pairs, then step over the current one.
  const pick = Math.floor(rand() * (count - 1));
  return pick >= current ? pick + 1 : pick;
}

export function Greeting({visible = true}: {visible?: boolean}) {
  const bloom = useRef(new Animated.Value(0)).current;
  // A fresh pair per launch: the initial pick is random, not the first entry.
  const [pair, setPair] = useState(() => nextPair(-1));

  // A new pair on each ARRIVAL at Home — the moment `visible` turns true. The
  // tab is hidden when this runs, so the new colours are already in place
  // when it appears; nothing changes while you are looking at it.
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      setPair(cur => nextPair(cur));
    }
    wasVisible.current = visible;
  }, [visible]);

  useEffect(() => {
    Animated.timing(bloom, {
      toValue: 1,
      duration: 620,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [bloom]);

  const [listen, buddy] = PAIRS[pair];

  return (
    <Animated.View
      accessible
      accessibilityRole="header"
      accessibilityLabel="Listen up Buddy"
      style={[
        styles.wrap,
        {
          opacity: bloom,
          transform: [
            {
              translateY: bloom.interpolate({
                inputRange: [0, 1],
                outputRange: [6, 0],
              }),
            },
          ],
        },
      ]}>
      <View style={styles.line}>
        <Text style={[styles.word, {color: listen}]}>Listen</Text>
        <Text style={[styles.word, styles.up]}>up</Text>
        <Text style={[styles.word, {color: buddy}]}>Buddy</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1, minWidth: 0},
  // A word gap, not a space character: each word is its own Text.
  line: {flexDirection: 'row', alignItems: 'baseline', gap: 8},
  // Each word states its weight itself — see the note at the top. lineHeight
  // gives the 'y' descender room; Android crops it otherwise.
  word: {fontSize: 32, lineHeight: 41, fontWeight: '900', letterSpacing: -1.1},
  up: {color: C.text},
});
