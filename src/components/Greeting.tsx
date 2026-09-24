/**
 * "Listen up Buddy" — the header on Home, one colour per letter.
 *
 * The colours are dealt fresh every time the app is opened: the palette is
 * shuffled ONCE, at module load, so a launch gets its own arrangement and keeps
 * it while you use the app — a header that re-rolled on every render would
 * flicker each time Home re-rendered.
 *
 * Every colour in the palette is bright enough to read on true black, and no
 * two neighbouring letters are ever given the same one, so the line always
 * reads as a run of colour rather than blocks of it.
 *
 * It blushes in on mount — a short fade and rise — so opening the app feels
 * like arriving somewhere rather than a list appearing.
 */
import React, {useEffect, useRef} from 'react';
import {Animated, Easing, StyleSheet, Text} from 'react-native';

const LINE = 'Listen up Buddy';

/** Vivid on #000, each distinct in hue from its neighbours in the wheel. */
const PALETTE = [
  '#FF5A5F', // coral red
  '#FF9F1C', // orange
  '#FFD23F', // sun yellow
  '#8AE234', // lime
  '#2EC4B6', // teal
  '#00B4FF', // sky
  '#7B8CFF', // periwinkle
  '#B388FF', // lavender
  '#FF6FD8', // pink
];

/**
 * A colour for every character of `text` (spaces get '' — they have none).
 *
 * The palette is shuffled with `rand`, then dealt round in that order, so
 * adjacent letters always differ as long as the palette has two or more
 * entries. Exported for the test.
 */
export function letterColors(
  text: string,
  palette: string[],
  rand: () => number = Math.random,
): string[] {
  const deck = [...palette];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  let n = 0;
  return [...text].map(ch => (ch === ' ' ? '' : deck[n++ % deck.length]));
}

// Once per launch — see the note at the top.
const COLORS = letterColors(LINE, PALETTE);

export function Greeting() {
  const bloom = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(bloom, {
      toValue: 1,
      duration: 620,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [bloom]);

  return (
    <Animated.View
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
      {/* One line, always: on a narrow phone the text shrinks rather than
          wrapping or being cut off. Read out as the phrase, not letter by
          letter. */}
      <Text
        style={styles.line}
        numberOfLines={1}
        adjustsFontSizeToFit
        accessibilityRole="header"
        accessibilityLabel={LINE}>
        {[...LINE].map((ch, i) => (
          <Text key={i} style={COLORS[i] ? {color: COLORS[i]} : null}>
            {ch}
          </Text>
        ))}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1, minWidth: 0},
  // lineHeight gives the 'y' descender room — Android crops it otherwise.
  line: {fontSize: 32, lineHeight: 41, fontWeight: '900', letterSpacing: -1.1},
});
