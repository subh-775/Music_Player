/**
 * A title that scrolls itself when it's too long to fit.
 *
 * Only animates when the text actually overflows — a short title sits still,
 * because text that drifts for no reason is worse than text that's clipped.
 * There's a pause at each end so the start is readable rather than perpetually
 * sliding past.
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
}: {
  text: string;
  style?: StyleProp<TextStyle>;
}) {
  const [boxWidth, setBoxWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);
  const shift = useRef(new Animated.Value(0)).current;

  const overflow = textWidth - boxWidth;
  const scrolls = overflow > 4;

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
  }, [scrolls, overflow, shift, text]);

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
