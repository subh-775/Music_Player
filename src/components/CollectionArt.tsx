/**
 * The square next to a library row.
 *
 * Liked Songs and Downloaded get their own glyph tiles — they're fixed rows and
 * a mosaic of whatever happens to be in them reads as noise. Everything else
 * shows its own cover, or a 2×2 mosaic built from the first four tracks, which
 * is what makes a playlist recognisable at a glance before you've read its name.
 */
import React from 'react';
import {Image, StyleSheet, View} from 'react-native';
import {ArrowDownToLine, Heart, Music2} from 'lucide-react-native';
import {C} from '../theme';
import {getBestArtworkUrl} from '../tracks';
import {type Collection} from '../collections';

export const LIKED_TINT = '#5b3df5';
export const DOWNLOAD_TINT = '#1db954';

export function CollectionArt({
  collection,
  size = 56,
}: {
  collection: Collection;
  size?: number;
}) {
  const radius = 4;
  const box = {width: size, height: size, borderRadius: radius};

  if (collection.kind === 'liked') {
    return (
      <View style={[box, styles.center, {backgroundColor: LIKED_TINT}]}>
        <Heart size={size * 0.42} color="#fff" fill="#fff" />
      </View>
    );
  }

  if (collection.kind === 'downloads') {
    return (
      <View style={[box, styles.center, {backgroundColor: DOWNLOAD_TINT}]}>
        <ArrowDownToLine size={size * 0.42} color="#fff" strokeWidth={2.6} />
      </View>
    );
  }

  if (collection.image) {
    return <Image source={{uri: collection.image}} style={[box, styles.fill]} />;
  }

  // Four covers make a mosaic; anything less would leave holes, so one cover
  // fills the square and none falls back to the placeholder glyph.
  const covers = collection.tracks
    .map(getBestArtworkUrl)
    .filter(Boolean)
    .slice(0, 4);

  if (covers.length >= 4) {
    return (
      <View style={[box, styles.mosaic]}>
        {covers.map((uri, i) => (
          <Image
            key={`${uri}-${i}`}
            source={{uri}}
            style={{width: size / 2, height: size / 2}}
          />
        ))}
      </View>
    );
  }

  if (covers.length) {
    return <Image source={{uri: covers[0]}} style={[box, styles.fill]} />;
  }

  return (
    <View style={[box, styles.center, styles.empty]}>
      <Music2 size={size * 0.36} color={C.faint} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: {alignItems: 'center', justifyContent: 'center'},
  fill: {backgroundColor: C.surface},
  mosaic: {flexDirection: 'row', flexWrap: 'wrap', overflow: 'hidden'},
  empty: {backgroundColor: C.surfaceHi},
});
