/**
 * Renders the current toast just above the player bar.
 *
 * Spotify's own recipe: a near-white bar with black text. Against an otherwise
 * dark UI it reads instantly without needing an icon.
 */
import React, {useEffect, useRef} from 'react';
import {Animated, StyleSheet, Text} from 'react-native';
import {useToast} from '../toast';
import {S} from '../theme';

export function Toaster({bottom = 96}: {bottom?: number}) {
  const item = useToast();
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: item ? 1 : 0,
      duration: item ? 220 : 160,
      useNativeDriver: true,
    }).start();
  }, [item, anim]);

  if (!item) {
    return null;
  }

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.wrap,
        item.kind === 'warn' && styles.warnWrap,
        {
          bottom,
          opacity: anim,
          transform: [
            {translateY: anim.interpolate({inputRange: [0, 1], outputRange: [10, 0]})},
          ],
        },
      ]}>
      <Text
        style={[styles.text, item.kind === 'warn' && styles.warnText]}
        numberOfLines={2}>
        {item.message}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: S.gutter,
    right: S.gutter,
    zIndex: 9999,
    borderRadius: 10,
    backgroundColor: '#f6f6f6',
    paddingHorizontal: 16,
    paddingVertical: 12,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 12,
    shadowOffset: {width: 0, height: 8},
  },
  text: {color: '#000', fontSize: 13, fontWeight: '700', textAlign: 'center'},
  // Warn: inverted from the everyday bar — dark pill with a green border —
  // so "press back again to exit" doesn't read like a song confirmation.
  warnWrap: {
    backgroundColor: '#161616',
    borderWidth: 1,
    borderColor: '#1db954',
    alignSelf: 'center',
    left: undefined,
    right: undefined,
    paddingHorizontal: 22,
    borderRadius: 999,
  },
  warnText: {color: '#fff'},
});
