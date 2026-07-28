/**
 * What's playing and what's next. Tap a row to jump to it.
 *
 * Reads the engine's real queue rather than a copy held in JS, so it can't
 * drift from what will actually play.
 *
 * There used to be a drag-to-reorder here on a JS PanResponder. Inside a
 * ScrollView it fought the scroll, re-rendered every frame, and left rows
 * overlapping on a bad drop — laggy and stubborn no matter how it was tuned. It
 * was pulled out; reorder belongs on a native gesture handler, not this.
 * ponytail: no reorder. Add back with a native draggable list if it's missed.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type {Track as RNTPTrack} from 'react-native-track-player';
import {C, S, T} from '../theme';
import {Event, TrackPlayer, sourceTrackFor} from '../player';

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
    // Refresh when the engine actually advances a track (or radio tops up,
    // which lands on the same event) — not on a timer.
    const sub = TrackPlayer.addEventListener(
      Event.PlaybackActiveTrackChanged,
      refresh,
    );
    return () => sub.remove();
  }, [refresh]);

  const jump = useCallback(
    async (index: number) => {
      try {
        await TrackPlayer.skip(index);
        await TrackPlayer.play();
        refresh();
      } catch {
        /* index vanished — the next event corrects it */
      }
    },
    [refresh],
  );

  const upcoming = useMemo(
    () => (active == null ? queue : queue.slice(active + 1)),
    [queue, active],
  );

  // Where the autoplay-radio tail begins — everything from here on was picked
  // by the app, not the user, and the divider says so.
  const firstRecommended = useMemo(
    () => queue.findIndex(t => sourceTrackFor(t)?._autoplay),
    [queue],
  );

  if (!queue.length) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>
          Nothing queued. Autoplay will keep the music going when this ends.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.wrap}
      contentContainerStyle={styles.body}
      showsVerticalScrollIndicator={false}>
      <Text style={styles.section}>{upcoming.length ? 'Next up' : 'Queue'}</Text>

      {queue.map((t, i) => {
        const recHeader = i === firstRecommended && firstRecommended > 0;
        return (
          <React.Fragment key={String(t.id ?? t.url ?? i)}>
            {recHeader && <Text style={styles.section}>Recommended for you</Text>}
            <TouchableOpacity
              style={styles.row}
              activeOpacity={0.7}
              onPress={() => jump(i)}>
              {t.artwork ? (
                <Image source={{uri: String(t.artwork)}} style={styles.art} />
              ) : (
                <View style={[styles.art, styles.artEmpty]} />
              )}
              <View style={styles.text}>
                <Text
                  style={[styles.title, i === active && styles.titleActive]}
                  numberOfLines={1}>
                  {String(t.title ?? '')}
                </Text>
                <Text style={styles.artist} numberOfLines={1}>
                  {String(t.artist ?? '')}
                </Text>
              </View>
            </TouchableOpacity>
          </React.Fragment>
        );
      })}
    </ScrollView>
  );
}

const ROW_H = 60;

const styles = StyleSheet.create({
  wrap: {flex: 1},
  body: {paddingBottom: 16},
  section: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: C.sub,
    paddingHorizontal: S.gutter,
    paddingTop: 10,
    paddingBottom: 6,
  },
  row: {
    height: ROW_H,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: S.gutter - 4,
    borderRadius: 10,
    gap: 12,
  },
  art: {width: 44, height: 44, borderRadius: 4, backgroundColor: C.surface},
  artEmpty: {backgroundColor: C.surfaceHi},
  text: {flex: 1, minWidth: 0},
  title: {...T.body, color: C.text},
  titleActive: {color: C.accent},
  artist: {...T.sub, color: C.sub, marginTop: 2},
  empty: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40},
  emptyText: {color: C.faint, fontSize: 13, textAlign: 'center', lineHeight: 19},
});
