/**
 * What's playing and what's next. Tap a row to jump; drag the grip to reorder.
 *
 * Reads the engine's real queue rather than a copy held in JS, so it can't
 * drift from what will actually play.
 *
 * ## Why this uses Reanimated rather than PanResponder
 *
 * Three previous attempts at drag-to-reorder were built on PanResponder +
 * Animated, and every one of them was reported as laggy. The reason is
 * structural, not a tuning problem: with PanResponder the gesture is delivered
 * to the JS thread, so every frame of a drag competes with React renders, the
 * playback event handlers and the backend fetches this app is doing constantly.
 * Under load the JS thread simply cannot keep 60fps, and the row visibly trails
 * the finger no matter how the maths is arranged.
 *
 * react-native-gesture-handler + Reanimated run the gesture and the row
 * transforms on the UI thread as worklets. JS is not in the frame loop at all,
 * so a busy JS thread cannot make the drag stutter. That is the whole reason
 * for the dependency, and it is why this one should actually feel right.
 *
 * ## Only upcoming tracks reorder
 *
 * The playing track is pinned above the list and cannot be dragged, and nothing
 * can be dropped above it. RNTP's remove() maps to ExoPlayer's removeMediaItem,
 * and removing the item that is currently playing stops playback — a queue
 * where the active row was draggable could kill the music mid-drag. This also
 * matches the reference build, whose queue is upcoming-only.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Image, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import DraggableFlatList, {
  ScaleDecorator,
  type RenderItemParams,
} from 'react-native-draggable-flatlist';
import {Menu} from 'lucide-react-native';
import type {Track as RNTPTrack} from 'react-native-track-player';
import {C, S, T} from '../theme';
import {Event, TrackPlayer, moveQueueItem, sourceTrackFor} from '../player';

const ROW_H = 60;

/**
 * How many songs are still to come — for the player's queue grip label.
 *
 * Its own tiny hook rather than a value lifted out of QueuePane, because the
 * grip is on screen while the queue sheet is closed and QueuePane is not
 * mounted. Event-driven, so it costs one queue read per track change and
 * nothing at all in between.
 */
export function useUpcomingCount(): number {
  const [n, setN] = useState(0);

  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const [q, i] = await Promise.all([
          TrackPlayer.getQueue(),
          TrackPlayer.getActiveTrackIndex(),
        ]);
        if (alive) {
          setN(Math.max(0, q.length - ((i ?? -1) + 1)));
        }
      } catch {
        if (alive) {
          setN(0);
        }
      }
    };
    read();
    const sub = TrackPlayer.addEventListener(
      Event.PlaybackActiveTrackChanged,
      read,
    );
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  return n;
}

export function QueuePane({
  onDragBegin,
  onDragEnd: onRowDragEnd,
}: {
  /**
   * A row has been lifted. Surfaced so the sheet this now lives in can stand
   * its own drag-to-dismiss down: Sheet activates at 12px of vertical travel
   * and DraggableFlatList activates at 12px too — a genuine tie, and the sheet
   * winning it means the row you meant to drag closes the queue instead.
   *
   * The state already existed internally as `dragging`; it just had no way out.
   */
  onDragBegin?: () => void;
  onDragEnd?: () => void;
} = {}) {
  const [queue, setQueue] = useState<RNTPTrack[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const dragging = useRef(false);
  // A drop writes the new order straight into state; the engine round-trip that
  // follows must not repaint the old order over it.
  const settleUntil = useRef(0);

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
    const sub = TrackPlayer.addEventListener(
      Event.PlaybackActiveTrackChanged,
      () => {
        if (!dragging.current && Date.now() > settleUntil.current) {
          refresh();
        }
      },
    );
    return () => sub.remove();
  }, [refresh]);

  const jump = useCallback(
    async (engineIndex: number) => {
      try {
        await TrackPlayer.skip(engineIndex);
        await TrackPlayer.play();
        refresh();
      } catch {
        /* index vanished — the next event corrects it */
      }
    },
    [refresh],
  );

  // -1 when nothing is active yet (a restored queue before the first play), so
  // the whole queue reads as "upcoming" rather than the list rendering blank.
  const activeIdx = active ?? -1;
  const upcoming = useMemo(
    () => queue.slice(activeIdx + 1),
    [queue, activeIdx],
  );
  const nowPlaying = active == null ? null : queue[active];

  const firstRecommended = useMemo(
    () => upcoming.findIndex(t => sourceTrackFor(t)?._autoplay),
    [upcoming],
  );

  /**
   * A drop landed. The list already shows the new order (the library hands us
   * the reordered array), so this only has to bring the engine into line.
   */
  const onDragEnd = useCallback(
    async ({from, to, data}: {from: number; to: number; data: RNTPTrack[]}) => {
      dragging.current = false;
      onRowDragEnd?.();
      if (from === to || activeIdx < 0) {
        return;
      }
      settleUntil.current = Date.now() + 2000;
      // Optimistic: keep the played tracks, splice in the reordered tail.
      setQueue(prev => [...prev.slice(0, activeIdx + 1), ...data]);
      const ok = await moveQueueItem(activeIdx + 1 + from, activeIdx + 1 + to);
      if (!ok) {
        settleUntil.current = 0;
        refresh(); // engine refused — show the truth rather than a lie
      }
    },
    [activeIdx, refresh, onRowDragEnd],
  );

  const renderItem = useCallback(
    ({item, getIndex, drag, isActive}: RenderItemParams<RNTPTrack>) => {
      const j = getIndex() ?? 0;
      return (
        <ScaleDecorator activeScale={1.03}>
          <Row
            track={item}
            onPress={() => jump(activeIdx + 1 + j)}
            onDrag={drag}
            lifted={isActive}
            recommended={firstRecommended >= 0 && j >= firstRecommended}
          />
        </ScaleDecorator>
      );
    },
    [jump, activeIdx, firstRecommended],
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
    <View style={styles.wrap}>
      {!!nowPlaying && (
        <>
          <Text style={styles.section}>Now playing</Text>
          <Row track={nowPlaying} activeRow />
        </>
      )}

      {upcoming.length > 0 && (
        <Text style={styles.section}>Next up · hold the grip to reorder</Text>
      )}

      <DraggableFlatList
        data={upcoming}
        keyExtractor={(t, i) => String(t.id ?? t.url ?? i)}
        renderItem={renderItem}
        onDragBegin={() => {
          dragging.current = true;
          onDragBegin?.();
        }}
        onDragEnd={onDragEnd}
        // Uniform rows: lets the list place the drop target without measuring,
        // which is what keeps a long queue smooth.
        getItemLayout={(_d, i) => ({
          length: ROW_H,
          offset: ROW_H * i,
          index: i,
        })}
        activationDistance={12}
        autoscrollThreshold={72}
        containerStyle={styles.listBox}
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

function Row({
  track: t,
  onPress,
  onDrag,
  lifted = false,
  activeRow = false,
  recommended = false,
}: {
  track: RNTPTrack;
  onPress?: () => void;
  onDrag?: () => void;
  lifted?: boolean;
  activeRow?: boolean;
  recommended?: boolean;
}) {
  return (
    <View style={[styles.row, lifted && styles.rowLifted]}>
      <TouchableOpacity
        style={styles.rowMain}
        activeOpacity={0.7}
        disabled={!onPress}
        onPress={onPress}>
        {t.artwork ? (
          <Image source={{uri: String(t.artwork)}} style={styles.art} />
        ) : (
          <View style={[styles.art, styles.artEmpty]} />
        )}
        <View style={styles.text}>
          <Text
            style={[styles.title, activeRow && styles.titleActive]}
            numberOfLines={1}>
            {String(t.title ?? '')}
          </Text>
          <Text style={styles.artist} numberOfLines={1}>
            {recommended && <Text style={styles.rec}>Recommended · </Text>}
            {String(t.artist ?? '')}
          </Text>
        </View>
      </TouchableOpacity>

      {!!onDrag && (
        // onLongPress, not onPressIn: the list needs to distinguish a scroll
        // from a drag, and grabbing on first touch would swallow flings.
        <TouchableOpacity
          style={styles.grip}
          onLongPress={onDrag}
          delayLongPress={120}
          activeOpacity={0.6}>
          <Menu size={19} color={C.faint} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1},
  listBox: {flex: 1},
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
    // Transparent: the queue sits over the player's own tinted background, and
    // an opaque row painted a black slab around every song.
    backgroundColor: 'transparent',
  },
  rowLifted: {backgroundColor: C.surfaceHi, elevation: 8},
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
  rec: {color: C.faint},
  grip: {paddingHorizontal: 14, paddingVertical: 18},
  empty: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40},
  emptyText: {
    color: C.faint,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
  },
});
