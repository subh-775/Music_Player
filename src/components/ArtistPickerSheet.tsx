/**
 * When a song credits several artists, tapping the credit has to ask WHICH one
 * you meant. This lists each name with their photo.
 *
 * A single credited artist skips the sheet entirely — the caller opens that
 * profile directly, because a one-item chooser is just an extra tap.
 *
 * Photos are fetched per name and land as they arrive; the sheet is usable
 * immediately with initials in place of a missing picture.
 */
import React, {useEffect, useRef, useState} from 'react';
import {
  Animated,
  Easing,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {C, S, T} from '../theme';
import {searchArtists} from '../backend';

export function ArtistPickerSheet({
  names,
  onPick,
  onClose,
}: {
  names: string[];
  onPick: (name: string) => void;
  onClose: () => void;
}) {
  const [images, setImages] = useState<Record<string, string>>({});
  const open = names.length > 0;

  /**
   * Presentation, hand-rolled instead of animationType="slide".
   *
   * "slide" moves the WHOLE modal — including the scrim — up from the bottom,
   * so the top edge of a 60%-black rectangle sweeps up the screen. That hard
   * travelling edge is the "harsh dark shadow above the popup". Here the sheet
   * slides and the scrim only fades, so nothing has a moving edge.
   */
  const t = useRef(new Animated.Value(0)).current; // 0 closed, 1 open

  useEffect(() => {
    Animated.timing(t, {
      toValue: open ? 1 : 0,
      duration: open ? 260 : 180,
      easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [open, t]);

  useEffect(() => {
    let alive = true;
    // One lookup per credited name, in parallel — there are rarely more than
    // three or four, and they're independent.
    Promise.all(
      names.map(async name => {
        try {
          const [hit] = await searchArtists(name, 1);
          return hit?.image ? ([name, hit.image] as const) : null;
        } catch {
          return null;
        }
      }),
    ).then(pairs => {
      if (!alive) {
        return;
      }
      setImages(Object.fromEntries(pairs.filter(Boolean) as Array<readonly [string, string]>));
    });
    return () => {
      alive = false;
    };
  }, [names]);

  return (
    <Modal
      visible={open}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent>
      <Animated.View style={[styles.scrim, {opacity: t}]}>
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          activeOpacity={1}
          onPress={onClose}
        />
      </Animated.View>
      <Animated.View
        style={[
          styles.sheet,
          {
            transform: [
              {
                translateY: t.interpolate({
                  inputRange: [0, 1],
                  outputRange: [SHEET_TRAVEL, 0],
                }),
              },
            ],
          },
        ]}>
        <View style={styles.handle} />
        <Text style={styles.title}>Artists on this song</Text>

        <ScrollView style={styles.list} bounces={false}>
          {names.map(name => {
            const image = images[name];
            return (
              <TouchableOpacity
                key={name}
                style={styles.row}
                activeOpacity={0.7}
                onPress={() => onPick(name)}>
                {image ? (
                  <Image source={{uri: image}} style={styles.pfp} />
                ) : (
                  <View style={[styles.pfp, styles.pfpEmpty]}>
                    <Text style={styles.initials}>
                      {name.trim().charAt(0).toUpperCase()}
                    </Text>
                  </View>
                )}
                <Text style={styles.name} numberOfLines={1}>
                  {name}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

/** Far enough that the sheet starts fully off-screen at any phone height. */
const SHEET_TRAVEL = 520;

const styles = StyleSheet.create({
  scrim: {...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)'},
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '65%',
    backgroundColor: C.surfaceHi,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 26,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    marginTop: 8,
  },
  title: {
    ...T.rowTitle,
    fontSize: 15,
    color: C.text,
    paddingHorizontal: S.gutter,
    paddingTop: 14,
    paddingBottom: 6,
  },
  list: {flexGrow: 0},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: S.gutter,
    paddingVertical: 9,
  },
  pfp: {width: 48, height: 48, borderRadius: 24, backgroundColor: C.surface},
  pfpEmpty: {alignItems: 'center', justifyContent: 'center'},
  initials: {color: C.sub, fontSize: 18, fontWeight: '700'},
  name: {...T.body, color: C.text, flex: 1, fontSize: 15},
});
