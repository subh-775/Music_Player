import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {C, S, T} from '../theme';
import {getLocalLibrary, type Track} from '../backend';
import {TrackRow} from '../components/TrackRow';

export function LibraryScreen({onPickTrack}: {onPickTrack: (t: Track) => void}) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const lib = await getLocalLibrary();
      setTracks(lib.tracks);
      setDir(lib.download_dir);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Library</Text>
      <Text style={styles.caption}>
        {tracks.length > 0
          ? `${tracks.length} downloaded ${
              tracks.length === 1 ? 'song' : 'songs'
            } · plays offline`
          : 'Songs you download appear here'}
      </Text>

      {busy && (
        <View style={styles.center}>
          <ActivityIndicator color={C.accent} />
        </View>
      )}

      {!!error && <Text style={styles.err}>{error}</Text>}

      {!busy && !error && tracks.length === 0 && (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Nothing downloaded yet</Text>
          <Text style={styles.emptyBody}>
            Downloaded songs are real files in your music folder — they play with
            no connection at all.
          </Text>
          {!!dir && <Text style={styles.dir}>{dir}</Text>}
        </View>
      )}

      {!busy && tracks.length > 0 && (
        <FlatList
          data={tracks}
          keyExtractor={(t, i) => `${t.title}-${i}`}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={load}
              tintColor={C.accent}
              colors={[C.accent]}
            />
          }
          renderItem={({item}) => (
            <TrackRow track={item} onPress={() => onPickTrack(item)} />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1},
  title: {
    ...T.screenTitle,
    color: C.text,
    paddingHorizontal: S.gutter,
    paddingTop: 8,
  },
  caption: {
    ...T.sub,
    color: C.sub,
    paddingHorizontal: S.gutter,
    marginTop: 4,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 34,
    gap: 8,
  },
  emptyTitle: {color: C.text, fontSize: 15.5, fontWeight: '700'},
  emptyBody: {color: C.sub, fontSize: 13, textAlign: 'center', lineHeight: 19},
  dir: {color: C.faint, fontSize: 11, textAlign: 'center', marginTop: 6},
  err: {color: C.danger, fontSize: 13, paddingHorizontal: S.gutter, paddingTop: 18},
  list: {paddingTop: 12, paddingBottom: 24},
});
