/**
 * A flat switch.
 *
 * RN's <Switch> is the platform widget: it draws its own elevation, a ripple
 * halo on press and a raised thumb, which is exactly the "effect around the
 * toggle" that made the settings list look busy. This is two rounded views and
 * a spring — no shadow, no ripple, no platform chrome.
 */
import React, {useEffect, useRef} from 'react';
import {Animated, Pressable, StyleSheet, View} from 'react-native';
import {C} from '../theme';

const W = 46;
const H = 27;
const PAD = 3;
const THUMB = H - PAD * 2;

export function Toggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const anim = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(anim, {
      toValue: value ? 1 : 0,
      // NATIVE. This was the last useNativeDriver:false animation in the app,
      // and it ran on every row of the Settings list. The blocker was
      // backgroundColor, which the driver genuinely cannot interpolate — so the
      // colour change is a CROSS-FADE between two stacked tracks instead, which
      // it can. Same look, none of it on the JS thread.
      useNativeDriver: true,
      speed: 18,
      bounciness: 4,
    }).start();
  }, [value, anim]);

  return (
    <Pressable
      onPress={() => !disabled && onChange(!value)}
      disabled={disabled}
      // Suppress the Android ripple; this control draws its own feedback.
      android_ripple={null}
      style={disabled ? styles.disabled : undefined}
      hitSlop={8}>
      <View style={styles.track}>
        {/* The "on" colour, faded in over the off colour underneath. */}
        <Animated.View
          style={[styles.on, {opacity: anim}]}
          pointerEvents="none"
        />
        <Animated.View
          style={[
            styles.thumb,
            {
              transform: [
                {
                  translateX: anim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, W - THUMB - PAD * 2],
                  }),
                },
              ],
            },
          ]}
        />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: {
    width: W,
    height: H,
    borderRadius: H / 2,
    padding: PAD,
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  on: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: H / 2,
    backgroundColor: C.accent,
  },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: '#fff',
  },
  disabled: {opacity: 0.4},
});
