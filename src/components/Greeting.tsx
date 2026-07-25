/**
 * "Good evening" — the time-of-day header on Home.
 *
 * The time word is colour-coded (morning amber, afternoon green, evening
 * violet) and blushes in: a short fade plus a brightness bloom, so opening the
 * app feels like arriving somewhere rather than a list appearing.
 *
 * The hour is read once per mount and again on a slow tick, so leaving the app
 * open across, say, 5:59pm doesn't leave it insisting it's still afternoon.
 */
import React, {useEffect, useRef, useState} from 'react';
import {Animated, Easing, StyleSheet, Text, View} from 'react-native';
import {C} from '../theme';
import {readSettings} from '../store';

function partOfDay(hour: number): {word: string; color: string} {
  if (hour < 12) {
    return {word: 'morning', color: '#f0b429'};
  }
  if (hour < 17) {
    return {word: 'afternoon', color: C.accentBright};
  }
  return {word: 'evening', color: '#a78bfa'};
}

export function Greeting() {
  const [hour, setHour] = useState(() => new Date().getHours());
  const bloom = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Re-check every few minutes; the boundary only matters to the minute.
    const id = setInterval(() => setHour(new Date().getHours()), 4 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (readSettings().reduceAnimations) {
      bloom.setValue(1); // no blush-in when the user asked for less motion
      return;
    }
    bloom.setValue(0);
    Animated.timing(bloom, {
      toValue: 1,
      duration: 620,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [bloom, hour]);

  const {word, color} = partOfDay(hour);

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
      <View style={styles.line}>
        <Text style={styles.good}>Good </Text>
        <Text style={[styles.word, {color}]}>{word}</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1, minWidth: 0},
  line: {flexDirection: 'row', alignItems: 'baseline'},
  // lineHeight gives the 'g' descender room — Android crops it otherwise.
  good: {fontSize: 32, lineHeight: 41, fontWeight: '900', color: C.text, letterSpacing: -1.1},
  word: {fontSize: 32, lineHeight: 41, fontWeight: '900', letterSpacing: -1.1},
});
