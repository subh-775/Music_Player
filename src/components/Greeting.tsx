/**
 * "Listen up Buddy!" — the header on Home, centred.
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
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
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

/** The largest size the line is set at; narrower phones get less. */
const MAX_SIZE = 32;
/** The line's width at font size 1, word gaps excluded: "Listen", "up" and
 *  "Buddy!" in Plus Jakarta Sans ExtraBold with this tracking, measured from
 *  the font file. */
const LINE_EM = 7.381;
const WORD_GAP = 8;

/** The font size that fits the line in `room` dp: MAX_SIZE on most phones,
 *  smaller where the screen is narrow, never wrapped or clipped. Exported for
 *  the test. */
export function fitSize(room: number): number {
  if (!(room > 0)) {
    return MAX_SIZE;
  }
  return Math.min(MAX_SIZE, Math.floor((room - 2 * WORD_GAP) / LINE_EM));
}

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

  // Sized to the room it is given (see fitSize). Before the first layout it
  // is set at the full size; the fade-in covers the one-frame adjustment.
  const [size, setSize] = useState(MAX_SIZE);
  const onBox = (e: LayoutChangeEvent) =>
    setSize(fitSize(e.nativeEvent.layout.width));
  const word = {
    fontSize: size,
    lineHeight: Math.round(size * 1.28),
    letterSpacing: -size * (1.1 / 32),
  };

  return (
    <Animated.View
      accessible
      accessibilityRole="header"
      accessibilityLabel="Listen up Buddy!"
      onLayout={onBox}
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
        <Text
          style={[styles.word, word, {color: listen}]}
          maxFontSizeMultiplier={1}>
          Listen
        </Text>
        <Text style={[styles.word, word, styles.up]} maxFontSizeMultiplier={1}>
          up
        </Text>
        <Text
          style={[styles.word, word, {color: buddy}]}
          maxFontSizeMultiplier={1}>
          Buddy!
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1, minWidth: 0},
  // Centred in its box; the box itself is centred on the screen by Home's
  // header (the mark on the left, a spacer of the same width on the right).
  // A word gap, not a space character: each word is its own Text.
  line: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    gap: WORD_GAP,
  },
  // Each word states its weight itself — see the note at the top. The size,
  // line height (room for the 'y' descender) and tracking come from fitSize.
  // maxFontSizeMultiplier={1} on each word: a display line sized to fit
  // exactly must not be scaled up by the system font size.
  word: {fontWeight: '900'},
  up: {color: C.text},
});
