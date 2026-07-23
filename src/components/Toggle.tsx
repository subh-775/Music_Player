/**
 * A flat switch.
 *
 * RN's <Switch> is the platform widget: it draws its own elevation, a ripple
 * halo on press and a raised thumb, which is exactly the "effect around the
 * toggle" that made the settings list look busy. This is two rounded views and
 * a spring — no shadow, no ripple, no platform chrome.
 */
import React, {useEffect, useRef} from 'react';
import {Animated, Pressable, StyleSheet} from 'react-native';
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
      useNativeDriver: false, // backgroundColor can't run on the native driver
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
      <Animated.View
        style={[
          styles.track,
          {
            backgroundColor: anim.interpolate({
              inputRange: [0, 1],
              outputRange: ['rgba(255,255,255,0.16)', C.accent],
            }),
          },
        ]}>
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
      </Animated.View>
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
  },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: '#fff',
  },
  disabled: {opacity: 0.4},
});
