/**
 * One track line. Shared by Search, Library and album/playlist screens so a
 * track looks and behaves the same everywhere in the app.
 */
import React from 'react';
import {Image, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {C, S, T} from '../theme';
import {formatDuration, type Track} from '../backend';

/** Brand tint per source, so where a track came from reads at a glance. */
export const SOURCE_TINT: Record<string, string> = {
  jiosaavn: '#2bd17e',
  soundcloud: '#ff7733',
  youtube: '#ff4444',
  youtube_music: '#ff4444',
  local: '#8b7bd8',
};

export function TrackRow({
  track,
  onPress,
  index,
}: {
  track: Track;
  onPress: () => void;
  index?: number;
}) {
  const source = track.playable_source || track.primary_source || '';
  const tint = SOURCE_TINT[source] || C.faint;
  const dur = formatDuration(track.duration_ms);

  return (
    <TouchableOpacity style={styles.row} activeOpacity={0.65} onPress={onPress}>
      {index != null ? (
        <Text style={styles.index}>{index + 1}</Text>
      ) : track.artwork_url ? (
        <Image source={{uri: track.artwork_url}} style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, styles.thumbFallback]} />
      )}
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {track.title}
        </Text>
        <View style={styles.metaLine}>
          {!!source && <View style={[styles.dot, {backgroundColor: tint}]} />}
          <Text style={styles.sub} numberOfLines={1}>
            {track.artist}
            {dur ? `  ·  ${dur}` : ''}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: S.gutter,
    paddingVertical: 8,
    gap: 12,
  },
  thumb: {width: 52, height: 52, borderRadius: 6, backgroundColor: C.surface},
  thumbFallback: {backgroundColor: C.surfaceHi},
  index: {
    width: 52,
    textAlign: 'center',
    color: C.faint,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  text: {flex: 1, minWidth: 0},
  title: {...T.body, color: C.text},
  metaLine: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3},
  dot: {width: 6, height: 6, borderRadius: 3},
  sub: {...T.sub, color: C.sub, flex: 1},
});
