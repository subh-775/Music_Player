/**
 * What's playing and what's next. Tap a row to jump; hold the grip to reorder.
 *
 * Reads the engine's real queue rather than a copy held in JS, so it can't
 * drift from what will actually play.
 *
 * The drag has two details that are easy to get wrong and very obvious when
 * they are:
 *   - the picked-up row ignores pointer events, so the hit-test finds the row
 *     UNDERNEATH it. With events on, it always finds itself, the target never
 *     changes, and every drop "snaps back".
 *   - rows between the pickup point and the finger slide out of the way by one
 *     row height, opening the gap the song is about to land in.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Animated,
  Image,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {Menu} from 'lucide-react-native';
import type {Track as RNTPTrack} from 'react-native-track-player';
import {C, S, T} from '../theme';
import {TrackPlayer} from '../player';

const ROW_H = 60;

export function QueuePane() {
  const [queue, setQueue] = useState<RNTPTrack[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const dragY = useRef(new Animated.Value(0)).current;
  const dragYValue = useRef(0);

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
    // this honest without wiring a listener per event type. Paused mid-drag so
    // a refresh can't reshuffle the list under the finger.
    const t = setInterval(() => {
      if (dragFrom === null) {
        refresh();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [refresh, dragFrom]);

  const jump = useCallback(
    async (index: number) => {
      try {
        await TrackPlayer.skip(index);
        await TrackPlayer.play();
        refresh();
      } catch {
        /* index vanished — the next poll corrects it */
      }
    },
    [refresh],
  );

  const commitMove = useCallback(
    async (from: number, to: number) => {
      if (from === to) {
        return;
      }
      try {
        // RNTP has no move(); remove and re-insert is the supported route.
        const item = queue[from];
        await TrackPlayer.remove([from]);
        await TrackPlayer.add([item], to);
      } catch {
        /* fall through to the refresh, which restores the truth */
      }
      refresh();
    },
    [queue, refresh],
  );

  const makeDragResponder = useCallback(
    (index: number) =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          setDragFrom(index);
          setDragOver(index);
          dragY.setValue(0);
          dragYValue.current = 0;
        },
        onPanResponderMove: (_e, g) => {
          dragY.setValue(g.dy);
          dragYValue.current = g.dy;
          // Which slot the finger is now over, derived from distance travelled
          // rather than a hit-test — no measurement, no dependence on the row
          // under the finger being laid out yet.
          const shifted = index + Math.round(g.dy / ROW_H);
          const clamped = Math.max(0, Math.min(queue.length - 1, shifted));
          setDragOver(clamped);
        },
        onPanResponderRelease: () => {
          const from = index;
          const to = Math.max(
            0,
            Math.min(queue.length - 1, index + Math.round(dragYValue.current / ROW_H)),
          );
          setDragFrom(null);
          setDragOver(null);
          dragY.setValue(0);
          commitMove(from, to);
        },
        onPanResponderTerminate: () => {
          setDragFrom(null);
          setDragOver(null);
          dragY.setValue(0);
        },
      }),
    [queue.length, dragY, commitMove],
  );

  const upcoming = useMemo(
    () => (active == null ? queue : queue.slice(active + 1)),
    [queue, active],
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
      scrollEnabled={dragFrom === null}
      showsVerticalScrollIndicator={false}>
      <Text style={styles.section}>
        {upcoming.length ? 'Next up · hold the grip to reorder' : 'Queue'}
      </Text>

      {queue.map((t, i) => {
        const isDragged = dragFrom === i;
        let shift = 0;
        if (dragFrom !== null && dragOver !== null && i !== dragFrom) {
          if (dragFrom < dragOver && i > dragFrom && i <= dragOver) {
            shift = -ROW_H;
          } else if (dragFrom > dragOver && i >= dragOver && i < dragFrom) {
            shift = ROW_H;
          }
        }

        return (
          <Animated.View
            key={`${t.id ?? t.url}-${i}`}
            style={[
              styles.row,
              isDragged && styles.rowDragged,
              isDragged
                ? [styles.lift, {transform: [{translateY: dragY}]}]
                : {transform: [{translateY: shift}]},
            ]}
            pointerEvents={isDragged ? 'none' : 'auto'}>
            <TouchableOpacity
              style={styles.rowMain}
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

            <View style={styles.grip} {...makeDragResponder(i).panHandlers}>
              <Menu size={19} color={C.faint} />
            </View>
          </Animated.View>
        );
      })}
    </ScrollView>
  );
}

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
  },
  rowDragged: {backgroundColor: C.surfaceHi, elevation: 8},
  lift: {zIndex: 5},
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minWidth: 0,
  },
  art: {width: 44, height: 44, borderRadius: 4, backgroundColor: C.surface},
  artEmpty: {backgroundColor: C.surfaceHi},
  text: {flex: 1, minWidth: 0},
  title: {...T.body, color: C.text},
  titleActive: {color: C.accent},
  artist: {...T.sub, color: C.sub, marginTop: 2},
  grip: {paddingHorizontal: 14, paddingVertical: 18},
  empty: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40},
  emptyText: {color: C.faint, fontSize: 13, textAlign: 'center', lineHeight: 19},
});
