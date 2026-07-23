/**
 * An opened album or playlist. Slides over the tabs rather than replacing them,
 * so closing it returns you exactly where you were.
 */
import React, {useEffect, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {C, S, T} from '../theme';
import {getCollection, type HomeItem, type Track} from '../backend';
import {TrackRow} from '../components/TrackRow';

export function CollectionScreen({
  item,
  onClose,
  onPickTrack,
}: {
  item: HomeItem | null;
  onClose: () => void;
  onPickTrack: (t: Track, context: Track[]) => void;
}) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!item?.perma_url) {
      return;
    }
    let alive = true;
    setBusy(true);
    setError('');
    setTracks([]);
    getCollection(item.perma_url)
      .then(res => {
        if (!alive) {
          return;
        }
        if (res.error && !res.tracks.length) {
          setError(res.error);
        }
        setTracks(res.tracks);
      })
      .catch(e => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [item]);

  if (!item) {
    return null;
  }

  const name = item.title || item.name || 'Collection';

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.wrap}>
        <View style={styles.bar}>
          <TouchableOpacity onPress={onClose} style={styles.back} hitSlop={12}>
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
        </View>

        <FlatList
          data={tracks}
          keyExtractor={(t, i) => `${t.title}-${i}`}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <View style={styles.header}>
              {item.image ? (
                <Image source={{uri: item.image}} style={styles.art} />
              ) : (
                <View style={[styles.art, styles.artFallback]} />
              )}
              <Text style={styles.name} numberOfLines={2}>
                {name}
              </Text>
              {!!item.subtitle && (
                <Text style={styles.sub} numberOfLines={1}>
                  {item.subtitle}
                </Text>
              )}
              {tracks.length > 0 && (
                <Text style={styles.count}>
                  {tracks.length} {tracks.length === 1 ? 'song' : 'songs'}
                </Text>
              )}
            </View>
          }
          renderItem={({item: t, index}) => (
            <TrackRow track={t} index={index} onPress={() => onPickTrack(t, tracks)} />
          )}
          ListEmptyComponent={
            busy ? (
              <View style={styles.center}>
                <ActivityIndicator color={C.accent} />
              </View>
            ) : (
              <View style={styles.center}>
                <Text style={styles.err}>
                  {error || 'Nothing playable in here.'}
                </Text>
              </View>
            )
          }
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1, backgroundColor: C.bg},
  bar: {paddingTop: 40, paddingHorizontal: 8},
  back: {width: 40, height: 36, justifyContent: 'center'},
  backText: {color: C.text, fontSize: 32, lineHeight: 34},
  list: {paddingBottom: 28},
  header: {alignItems: 'center', paddingHorizontal: S.gutter, paddingBottom: 18},
  art: {width: 190, height: 190, borderRadius: 10, backgroundColor: C.surface},
  artFallback: {backgroundColor: C.surfaceHi},
  name: {
    color: C.text,
    fontSize: 21,
    fontWeight: '800',
    letterSpacing: -0.3,
    textAlign: 'center',
    marginTop: 16,
  },
  sub: {...T.sub, color: C.sub, marginTop: 5, textAlign: 'center'},
  count: {...T.sub, color: C.faint, marginTop: 8},
  center: {paddingTop: 40, alignItems: 'center'},
  err: {color: C.danger, fontSize: 13, textAlign: 'center', paddingHorizontal: 30},
});
