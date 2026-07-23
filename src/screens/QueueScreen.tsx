/**
 * What's playing and what's next. Tapping a row jumps straight to it.
 *
 * Reads the engine's real queue rather than a copy held in JS, so it can't
 * drift from what will actually play.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  FlatList,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type {Track as RNTPTrack} from 'react-native-track-player';
import {C, S, T} from '../theme';
import {TrackPlayer, shuffleQueue} from '../player';

export function QueuePane() {
  const [queue, setQueue] = useState<RNTPTrack[]>([]);
  const [active, setActive] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [q, i] = await Promise.all([
        TrackPlayer.getQueue(),
        TrackPlayer.getActiveTrackIndex(),
      ]);
      setQueue(q);
      setActive(i ?? null);
    } catch {
      setQueue([]);
    }
  }, []);

  useEffect(() => {
    refresh();
    // The queue changes on track advance and on shuffle; a light poll keeps
    // this honest without wiring a listener per event type.
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [refresh]);

  const jump = useCallback(
    async (index: number) => {
      try {
        await TrackPlayer.skip(index);
        await TrackPlayer.play();
        refresh();
      } catch {
        /* index vanished under us — the poll will correct the list */
      }
    },
    [refresh],
  );

  if (!queue.length) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>Nothing queued yet.</Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={styles.count}>
          {queue.length} {queue.length === 1 ? 'song' : 'songs'}
        </Text>
        <TouchableOpacity
          onPress={() => shuffleQueue().then(refresh)}
          hitSlop={10}>
          <Text style={styles.shuffle}>Shuffle</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={queue}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={styles.list}
        renderItem={({item, index}) => {
          const isNow = index === active;
          const isPast = active != null && index < active;
          return (
            <TouchableOpacity
              style={styles.row}
              activeOpacity={0.65}
              onPress={() => jump(index)}>
              {item.artwork ? (
                <Image
                  source={{uri: String(item.artwork)}}
                  style={[styles.thumb, isPast && styles.dim]}
                />
              ) : (
                <View style={[styles.thumb, styles.thumbFallback]} />
              )}
              <View style={styles.text}>
                <Text
                  style={[
                    styles.title,
                    isNow && styles.titleNow,
                    isPast && styles.dim,
                  ]}
                  numberOfLines={1}>
                  {item.title}
                </Text>
                <Text
                  style={[styles.sub, isPast && styles.dim]}
                  numberOfLines={1}>
                  {isNow ? 'Now playing' : item.artist}
                </Text>
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1},
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  count: {...T.sub, color: C.faint},
  shuffle: {...T.sub, color: C.accent, fontWeight: '700'},
  list: {paddingBottom: 20},
  row: {flexDirection: 'row', alignItems: 'center', paddingVertical: 7, gap: 12},
  thumb: {width: 44, height: 44, borderRadius: 5, backgroundColor: C.surface},
  thumbFallback: {backgroundColor: C.surfaceHi},
  text: {flex: 1, minWidth: 0},
  title: {...T.body, color: C.text},
  titleNow: {color: C.accent},
  sub: {...T.sub, color: C.sub, marginTop: 2},
  dim: {opacity: 0.45},
  empty: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  emptyText: {color: C.sub, fontSize: 13.5},
  gutter: {paddingHorizontal: S.gutter},
});
