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
import {Event, TrackPlayer, sourceTrackFor} from '../player';

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

  // A just-committed reorder must not be clobbered by the poll reading the
  // engine's still-catching-up queue — that read-back was the "drop, then it
  // jumps" lag. Suppress the refresh for a beat after a move.
  const settleUntil = useRef(0);

  useEffect(() => {
    refresh();
    // Event-driven, NOT polled. The old 1s poll repainted the list every second
    // from the engine — which is what made a just-dropped reorder appear to take
    // a beat to "settle". Now we only refresh when the engine actually advances
    // a track (or radio tops up, which lands on the same event), and never
    // mid-drag or within the settle window after a drop.
    const sub = TrackPlayer.addEventListener(
      Event.PlaybackActiveTrackChanged,
      () => {
        if (dragFrom === null && Date.now() > settleUntil.current) {
          refresh();
        }
      },
    );
    return () => sub.remove();
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
      // Optimistic: the list snaps to its new order the instant the finger
      // lifts. Waiting for the engine round-trip left a beat where rows
      // seemed to wander, which read as the drop not having taken.
      setQueue(prev => {
        const next = [...prev];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return next;
      });
      setActive(prev => {
        if (prev == null) {
          return prev;
        }
        if (prev === from) {
          return to;
        }
        if (from < prev && to >= prev) {
          return prev - 1;
        }
        if (from > prev && to <= prev) {
          return prev + 1;
        }
        return prev;
      });
      settleUntil.current = Date.now() + 1500;
      try {
        // RNTP has no move(); remove and re-insert is the supported route.
        const item = queue[from];
        await TrackPlayer.remove([from]);
        await TrackPlayer.add([item], to);
      } catch {
        refresh(); // engine refused — restore the truth
      }
    },
    [queue, refresh],
  );

  // Live values behind the drag handlers. The responders MUST be stable across
  // renders: setDragOver re-renders mid-gesture, and handing the row a freshly
  // created responder at that moment orphans the active gesture — which is
  // exactly the "I dragged it and it snapped back" bug. So each index gets ONE
  // responder, forever, and it reads current state through these refs.
  const queueLenRef = useRef(0);
  queueLenRef.current = queue.length;
  const commitRef = useRef(commitMove);
  commitRef.current = commitMove;
  const responders = useRef(new Map<number, ReturnType<typeof PanResponder.create>>());

  const dragResponderFor = useCallback(
    (index: number) => {
      let r = responders.current.get(index);
      if (!r) {
        r = PanResponder.create({
          onStartShouldSetPanResponder: () => true,
          onMoveShouldSetPanResponder: () => true,
          // The ScrollView must not steal the gesture once the grip has it.
          onPanResponderTerminationRequest: () => false,
          onPanResponderGrant: () => {
            setDragFrom(index);
            setDragOver(index);
            dragY.setValue(0);
            dragYValue.current = 0;
          },
          onPanResponderMove: (_e, g) => {
            dragY.setValue(g.dy);
            dragYValue.current = g.dy;
            // Which slot the finger is over, from distance travelled — no
            // hit-testing, no dependence on layout timing.
            const shifted = index + Math.round(g.dy / ROW_H);
            setDragOver(Math.max(0, Math.min(queueLenRef.current - 1, shifted)));
          },
          onPanResponderRelease: () => {
            const to = Math.max(
              0,
              Math.min(
                queueLenRef.current - 1,
                index + Math.round(dragYValue.current / ROW_H),
              ),
            );
            setDragFrom(null);
            setDragOver(null);
            dragY.setValue(0);
            commitRef.current(index, to);
          },
          onPanResponderTerminate: () => {
            setDragFrom(null);
            setDragOver(null);
            dragY.setValue(0);
          },
        });
        responders.current.set(index, r);
      }
      return r;
    },
    [dragY],
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

        const recHeader =
          i === firstRecommended && firstRecommended > 0 && dragFrom === null;

        // Key by the track's own identity, NOT the index. With the index in the
        // key, a reorder changed every moved row's key, so React unmounted and
        // remounted them — the artwork re-decoded and the list visibly lagged
        // catching up to the drop. A stable key lets React MOVE the same row.
        return (
          <React.Fragment key={String(t.id ?? t.url ?? i)}>
            {recHeader && (
              <Text style={styles.section}>Recommended for you</Text>
            )}
            <QueueRow
              track={t}
              index={i}
              isActive={i === active}
              isDragged={isDragged}
              shift={shift}
              dragY={dragY}
              panHandlers={dragResponderFor(i).panHandlers}
              onJump={jump}
            />
          </React.Fragment>
        );
      })}
    </ScrollView>
  );
}

/**
 * One queue row, memoized: while a drag repaints the screen every frame, only
 * the picked-up row and the rows sliding out of its way re-render — which is
 * the difference between a drag that glides and one that stutters.
 */
const QueueRow = React.memo(function QueueRow({
  track: t,
  index,
  isActive,
  isDragged,
  shift,
  dragY,
  panHandlers,
  onJump,
}: {
  track: RNTPTrack;
  index: number;
  isActive: boolean;
  isDragged: boolean;
  shift: number;
  dragY: Animated.Value;
  panHandlers: object;
  onJump: (i: number) => void;
}) {
  return (
    <Animated.View
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
        onPress={() => onJump(index)}>
        {t.artwork ? (
          <Image source={{uri: String(t.artwork)}} style={styles.art} />
        ) : (
          <View style={[styles.art, styles.artEmpty]} />
        )}
        <View style={styles.text}>
          <Text
            style={[styles.title, isActive && styles.titleActive]}
            numberOfLines={1}>
            {String(t.title ?? '')}
          </Text>
          <Text style={styles.artist} numberOfLines={1}>
            {String(t.artist ?? '')}
          </Text>
        </View>
      </TouchableOpacity>

      <View style={styles.grip} {...panHandlers}>
        <Menu size={19} color={C.faint} />
      </View>
    </Animated.View>
  );
});

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
