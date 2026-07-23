/**
 * A plain list of tracks with a title — used for Liked Songs and Downloaded.
 * Play All / Shuffle sit in the header so a list is one tap from playing.
 */
import React from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {ChevronLeft, Play, Shuffle} from 'lucide-react-native';
import {C, S, T} from '../theme';
import type {Track} from '../backend';
import {TrackRow} from '../components/TrackRow';

export function TrackListScreen({
  title,
  tracks,
  onClose,
  onPickTrack,
}: {
  title: string;
  tracks: Track[];
  onClose: () => void;
  onPickTrack: (t: Track, context: Track[]) => void;
}) {
  const shufflePlay = () => {
    if (!tracks.length) {
      return;
    }
    const order = [...tracks];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    onPickTrack(order[0], order);
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.back}>
          <ChevronLeft size={28} color={C.text} />
        </TouchableOpacity>
        <Text style={styles.barTitle} numberOfLines={1}>
          {title}
        </Text>
      </View>

      <FlatList
        data={tracks}
        keyExtractor={(t, i) => `${t.title}-${i}`}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          tracks.length ? (
            <View style={styles.actions}>
              <TouchableOpacity
                style={styles.playAll}
                activeOpacity={0.85}
                onPress={() => onPickTrack(tracks[0], tracks)}>
                <Play size={17} color={C.bg} fill={C.bg} strokeWidth={1} />
                <Text style={styles.playAllText}>Play all</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.shuffleBtn}
                activeOpacity={0.85}
                onPress={shufflePlay}>
                <Shuffle size={17} color={C.text} strokeWidth={2.2} />
                <Text style={styles.shuffleText}>Shuffle</Text>
              </TouchableOpacity>
            </View>
          ) : null
        }
        renderItem={({item}) => (
          <TrackRow track={item} onPress={() => onPickTrack(item, tracks)} />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              {title === 'Liked Songs'
                ? 'Songs you like will appear here. Tap the heart on any track.'
                : 'Nothing downloaded yet.'}
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1, backgroundColor: C.bg},
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: 12,
    paddingHorizontal: 8,
    paddingBottom: 6,
  },
  back: {padding: 4},
  barTitle: {...T.screenTitle, color: C.text, fontSize: 22, flex: 1},
  list: {paddingBottom: 24},
  actions: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: S.gutter,
    paddingBottom: 12,
  },
  playAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: C.accent,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 999,
  },
  playAllText: {color: C.bg, fontWeight: '800', fontSize: 13.5},
  shuffleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: C.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 999,
  },
  shuffleText: {color: C.text, fontWeight: '700', fontSize: 13.5},
  empty: {paddingTop: 50, paddingHorizontal: 40},
  emptyText: {
    color: C.sub,
    fontSize: 13.5,
    textAlign: 'center',
    lineHeight: 20,
  },
});
