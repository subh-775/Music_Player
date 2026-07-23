/**
 * The persistent mini player. Rendered only once the audio engine is up, so it
 * never appears on a build without native playback.
 */
import React from 'react';
import {
  ActivityIndicator,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  useActiveTrack,
  usePlaybackState,
  useProgress,
} from 'react-native-track-player';
import {C, S, T} from '../theme';
import {State, togglePlay} from '../player';

export function PlayerBar({onExpand}: {onExpand: () => void}) {
  const track = useActiveTrack();
  const {state} = usePlaybackState() as {state?: State};
  const {position, duration} = useProgress(500);

  if (!track) {
    return null;
  }

  const playing = state === State.Playing;
  const loading = state === State.Buffering || state === State.Loading;
  const pct = duration > 0 ? Math.min(1, position / duration) : 0;

  return (
    <View style={styles.wrap}>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, {flex: pct}]} />
        <View style={{flex: 1 - pct}} />
      </View>
      <TouchableOpacity
        style={styles.row}
        activeOpacity={0.8}
        onPress={onExpand}>
        {track.artwork ? (
          <Image source={{uri: String(track.artwork)}} style={styles.art} />
        ) : (
          <View style={[styles.art, styles.artFallback]} />
        )}
        <View style={styles.meta}>
          <Text style={styles.title} numberOfLines={1}>
            {track.title}
          </Text>
          <Text style={styles.artist} numberOfLines={1}>
            {track.artist}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.btn}
          onPress={togglePlay}
          hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
          {loading ? (
            <ActivityIndicator color={C.text} size="small" />
          ) : (
            <Text style={styles.btnIcon}>{playing ? '❚❚' : '▶'}</Text>
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: C.surfaceHi,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  progressTrack: {flexDirection: 'row', height: 2, backgroundColor: C.border},
  progressFill: {backgroundColor: C.accent},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: S.gutter,
    paddingVertical: 9,
    gap: 12,
  },
  art: {width: 42, height: 42, borderRadius: 5, backgroundColor: C.surface},
  artFallback: {backgroundColor: C.surface},
  meta: {flex: 1, minWidth: 0},
  title: {...T.body, color: C.text},
  artist: {...T.sub, color: C.sub, marginTop: 2},
  btn: {paddingHorizontal: 6, paddingVertical: 4},
  btnIcon: {color: C.text, fontSize: 17},
});
