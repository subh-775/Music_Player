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
import React, {useEffect, useState} from 'react';
import {
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {C, S, T} from '../theme';
import {searchArtists} from '../backend';
import {Sheet} from './Sheet';

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
   * The names held through the close animation.
   *
   * `names` empties the instant a choice is made, and <Sheet> keeps the panel
   * mounted while it slides away — so rendering straight off the prop would
   * show an EMPTY sheet finishing the exit. The Modal hid this by tearing its
   * whole window down at once.
   */
  const [shown, setShown] = useState<string[]>(names);

  useEffect(() => {
    if (names.length) {
      setShown(names);
    }
  }, [names]);

  // The scrim-fades-while-the-sheet-slides presentation this used to hand-roll
  // — to avoid animationType="slide" dragging a hard-edged black rectangle up
  // the screen — is what <Sheet> now does for every sheet in the app, and it is
  // a view rather than a window, so there is no WindowManager transaction at
  // either end.

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
      setImages(
        Object.fromEntries(
          pairs.filter(Boolean) as Array<readonly [string, string]>,
        ),
      );
    });
    return () => {
      alive = false;
    };
  }, [names]);

  return (
    <Sheet open={open} onClose={onClose} style={styles.sheet}>
      <Text style={styles.title}>Artists on this song</Text>

      <ScrollView style={styles.list} bounces={false}>
        {shown.map(name => {
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
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // Scrim, handle, rounded top and the slide all live in <Sheet> now.
  sheet: {maxHeight: '65%'},
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
