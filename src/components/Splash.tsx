/**
 * Startup screen: the app's own icon, breathing gently, instead of the old
 * "Starting the music engine…" spinner — an app should announce itself with its
 * mark, not a status line. Shown only on a true cold start (no cached Home rows
 * and no restored session).
 */
import React, {useEffect, useRef} from 'react';
import {Animated, Easing, Image, StyleSheet, View} from 'react-native';
import {C} from '../theme';

const ICON = require('../assets/app-icon.png');

export function Splash() {
  const enter = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(enter, {
      toValue: 1,
      duration: 420,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 950,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 950,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [enter, pulse]);

  const scale = Animated.multiply(
    enter.interpolate({inputRange: [0, 1], outputRange: [0.82, 1]}),
    pulse.interpolate({inputRange: [0, 1], outputRange: [1, 1.06]}),
  );

  return (
    <View style={styles.wrap}>
      <Animated.View
        style={{
          opacity: enter,
          transform: [{scale}],
        }}>
        <Image source={ICON} style={styles.icon} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg},
  icon: {width: 92, height: 92, borderRadius: 21},
});
