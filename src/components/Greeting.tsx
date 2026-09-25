/**
 * "Listen up Buddy" — the header on Home.
 *
 * "Listen" and "Buddy" each wear one colour, "up" stays white. The colours are
 * dealt at launch and then keep changing: every few seconds one of the two
 * coloured words dips, takes a new colour, and comes back — never the colour
 * the other word is wearing, never the one it had.
 *
 * Three SIBLING Texts, each with its own weight, not one Text with nested
 * spans. The app's default font (src/font.ts) names the family on every Text;
 * on Android a nested span that names a family without a weight resets to
 * that family's REGULAR weight — which is how per-letter spans came out thin
 * and looking like a different typeface.
 *
 * It blushes in on mount — a short fade and rise — so opening the app feels
 * like arriving somewhere rather than a list appearing.
 */
import React, {useEffect, useRef, useState} from 'react';
import {Animated, Easing, StyleSheet, View} from 'react-native';
import {C} from '../theme';

/** Vivid on #000, and far enough apart in hue that two never read as one. */
export const WORD_PALETTE = [
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

/** How long each word keeps a colour before its turn to change comes round. */
const CHANGE_EVERY_MS = 4500;

/**
 * A new colour for one word: not what it has now, and not what the other
 * coloured word has. Exported for the test.
 */
export function nextColor(
  current: string | null,
  other: string | null,
  palette: string[] = WORD_PALETTE,
  rand: () => number = Math.random,
): string {
  const pool = palette.filter(c => c !== current && c !== other);
  return pool[Math.floor(rand() * pool.length)] ?? palette[0];
}

/** One coloured word, which fades through its colour changes. */
function ColorWord({text, color}: {text: string; color: string}) {
  const [shown, setShown] = useState(color);
  const fade = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (color === shown) {
      return;
    }
    // Dip, swap while it is faint, come back — a change you see happen, not
    // a flicker. Native driver: opacity only, nothing on the JS thread.
    Animated.timing(fade, {
      toValue: 0.15,
      duration: 180,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start(() => {
      setShown(color);
      Animated.timing(fade, {
        toValue: 1,
        duration: 260,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
    });
  }, [color, shown, fade]);

  return (
    <Animated.Text style={[styles.word, {color: shown, opacity: fade}]}>
      {text}
    </Animated.Text>
  );
}

export function Greeting() {
  const bloom = useRef(new Animated.Value(0)).current;
  const [listen, setListen] = useState(() => nextColor(null, null));
  const [buddy, setBuddy] = useState(() => nextColor(null, null));

  // Make sure the two start apart (the initialisers cannot see each other).
  useEffect(() => {
    if (buddy === listen) {
      setBuddy(nextColor(buddy, listen));
    }
  }, [buddy, listen]);

  // Take turns: one word changes, then the other.
  const turn = useRef(0);
  useEffect(() => {
    const id = setInterval(() => {
      turn.current += 1;
      if (turn.current % 2) {
        setListen(cur => nextColor(cur, buddy));
      } else {
        setBuddy(cur => nextColor(cur, listen));
      }
    }, CHANGE_EVERY_MS);
    return () => clearInterval(id);
  }, [listen, buddy]);

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
        <ColorWord text="Listen" color={listen} />
        <Animated.Text style={[styles.word, styles.up]}>up</Animated.Text>
        <ColorWord text="Buddy" color={buddy} />
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
