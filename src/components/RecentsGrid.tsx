/**
 * Recents: the last nine songs you played, as a three-by-three grid of covers
 * at the top of Home — the "speed dial" layout YouTube Music uses.
 *
 * A tap plays the song with the rest of your recents queued after it. The
 * song playing now wears a white outline, so the grid also answers "what is
 * this" at a glance.
 *
 * Each tile's title sits on a soft fade rather than a solid bar, so a cover
 * keeps its whole picture and the name stays readable over a light one.
 */
import React, {useMemo} from 'react';
import {
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import Svg, {Defs, LinearGradient, Rect, Stop} from 'react-native-svg';
import {C, S, T} from '../theme';
import {cleanText, getBestArtworkUrl, getTrackId} from '../tracks';
import {useIsActiveTrack} from '../player';
import type {Track} from '../backend';

const COLUMNS = 3;
const MAX_TILES = 9;
const GAP = 8;

export function RecentsGrid({
  recent,
  onPlay,
}: {
  recent: Track[];
  onPlay: (track: Track, context: Track[]) => void;
}) {
  const {width} = useWindowDimensions();
  const tiles = useMemo(() => recent.slice(0, MAX_TILES), [recent]);
  if (!tiles.length) {
    return null;
  }
  // Three per row across the page's own margins, whatever the screen width.
  const size = Math.floor(
    (width - 2 * S.gutter - (COLUMNS - 1) * GAP) / COLUMNS,
  );
  return (
    <View style={styles.section}>
      <Text style={styles.title}>Recents</Text>
      <View style={styles.grid}>
        {tiles.map(t => (
          <Tile
            key={getTrackId(t)}
            track={t}
            size={size}
            onPress={() => onPlay(t, recent)}
          />
        ))}
      </View>
    </View>
  );
}

const Tile = React.memo(function Tile({
  track,
  size,
  onPress,
}: {
  track: Track;
  size: number;
  onPress: () => void;
}) {
  const playing = useIsActiveTrack(track.title, track.artist);
  const art = getBestArtworkUrl(track);
  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={onPress}
      style={[styles.tile, {width: size, height: size}]}
      accessibilityRole="button"
      accessibilityLabel={`Play ${cleanText(track.title)}`}>
      {art ? (
        <Image source={{uri: art}} style={styles.fill} />
      ) : (
        <View style={[styles.fill, styles.fallback]} />
      )}
      <Svg style={styles.fade} pointerEvents="none">
        <Defs>
          <LinearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#000" stopOpacity={0} />
            <Stop offset="1" stopColor="#000" stopOpacity={0.78} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#fade)" />
      </Svg>
      <Text style={styles.name} numberOfLines={1}>
        {cleanText(track.title)}
      </Text>
      {playing && <View style={styles.playing} pointerEvents="none" />}
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  section: {marginTop: 6},
  title: {
    ...T.rowTitle,
    color: C.text,
    paddingHorizontal: S.gutter,
    marginBottom: 10,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GAP,
    paddingHorizontal: S.gutter,
  },
  tile: {
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: C.surface,
  },
  fill: {...StyleSheet.absoluteFillObject},
  fallback: {backgroundColor: C.surfaceHi},
  // The lower half: where the name sits.
  fade: {position: 'absolute', left: 0, right: 0, bottom: 0, height: '55%'},
  name: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 7,
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  playing: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#fff',
  },
});
