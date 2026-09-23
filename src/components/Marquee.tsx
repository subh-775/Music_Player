/**
 * A title that scrolls itself when it's too long to fit.
 *
 * Only animates when the text actually overflows — a short title sits still,
 * because text that drifts for no reason is worse than text that's clipped.
 * There's a pause at each end so the start is readable rather than perpetually
 * sliding past.
 *
 * `ticker` is the other motion: the line drifts right to left until it is gone,
 * re-enters from the right edge and settles back at its start, then rests.
 * For a credit with several artists, which gets it whether or not it fits —
 * the drift is what says "there is more than one name here".
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
} from 'react-native';

const SPEED = 32; // px per second — slow enough to read while it moves
const PAUSE = 1200;

export function Marquee({
  text,
  style,
  ticker = false,
  paused = false,
}: {
  text: string;
  style?: StyleProp<TextStyle>;
  ticker?: boolean;
  /** Hold still — for a copy that is laid out but not on screen, where a
   *  native loop would still run every frame for nobody. */
  paused?: boolean;
}) {
  const [boxWidth, setBoxWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);
  const shift = useRef(new Animated.Value(0)).current;

  const overflow = textWidth - boxWidth;
  const scrolls =
    !paused && (ticker ? textWidth > 0 && boxWidth > 0 : overflow > 4);

  const onBox = useCallback((e: LayoutChangeEvent) => {
    setBoxWidth(e.nativeEvent.layout.width);
  }, []);
  const onText = useCallback((e: LayoutChangeEvent) => {
    setTextWidth(e.nativeEvent.layout.width);
  }, []);

  useEffect(() => {
    shift.stopAnimation();
    shift.setValue(0);
    if (!scrolls) {
      return;
    }
    if (ticker) {
      // Out past the left edge, jump to just beyond the right one, glide home.
      // The jump happens while nothing is visible, so it never reads as one.
      const out = Animated.timing(shift, {
        toValue: -textWidth,
        duration: (textWidth / SPEED) * 1000,
        easing: Easing.linear,
        useNativeDriver: true,
      });
      const jump = Animated.timing(shift, {
        toValue: boxWidth,
        duration: 0,
        useNativeDriver: true,
      });
      const home = Animated.timing(shift, {
        toValue: 0,
        duration: (boxWidth / SPEED) * 1000,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      });
      const tick = Animated.loop(
        Animated.sequence([Animated.delay(PAUSE * 2), out, jump, home]),
      );
      tick.start();
      return () => tick.stop();
    }
    const travel = (overflow / SPEED) * 1000;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(PAUSE),
        Animated.timing(shift, {
          toValue: -overflow,
          duration: travel,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        Animated.delay(PAUSE),
        Animated.timing(shift, {
          toValue: 0,
          duration: travel,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
    // text is in the deps so a track change restarts from the beginning.
  }, [scrolls, overflow, shift, text, ticker, textWidth, boxWidth]);

  return (
    <View style={styles.clip} onLayout={onBox}>
      <Animated.View style={{transform: [{translateX: shift}]}}>
        <Text
          style={[style, styles.text]}
          numberOfLines={1}
          onLayout={onText}>
          {text}
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: {overflow: 'hidden'},
  // Width must be intrinsic for onLayout to report the real text width; a
  // flexed Text would just report the box and never scroll.
  text: {alignSelf: 'flex-start'},
});
