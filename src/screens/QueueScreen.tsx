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
import {type SharedValue} from 'react-native-reanimated';
import DraggableFlatList, {
  ScaleDecorator,
  type RenderItemParams,
} from 'react-native-draggable-flatlist';
import {Headphones, Menu, Shuffle} from 'lucide-react-native';
import type {Track as RNTPTrack} from 'react-native-track-player';
import {C, S, T} from '../theme';
import {
  Event,
  TrackPlayer,
  moveQueueItem,
  onQueueChanged,
  sourceTrackFor,
  useShuffle,
} from '../player';
import {useAudioOutput} from '../audioOutput';
import {splitArtists} from '../tracks';

const ROW_H = 60;

/**
 * The last queue we read, kept at module scope.
 *
 * The queue is a sheet now, so QueuePane MOUNTS when it opens — and a mount
 * that has to await two engine round-trips before it can draw anything is a
 * sheet that slides up empty and fills in a beat later. Now that the pull
 * drives the sheet with the finger, that gap is directly visible. Render the
 * last known queue immediately and correct it when the read lands.
 */
let lastQueue: RNTPTrack[] = [];
let lastActive: number | null = null;

export function QueuePane({
  onDragBegin,
  onDragEnd: onRowDragEnd,
  scrollY,
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
  /** The sheet's scroll-awareness. See <Sheet scrollY>. */
  scrollY?: SharedValue<number>;
} = {}) {
  const [queue, setQueue] = useState<RNTPTrack[]>(lastQueue);
  const [active, setActive] = useState<number | null>(lastActive);
  const shuffled = useShuffle();
  const output = useAudioOutput();
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
      lastQueue = q;
      lastActive = i ?? null;
    } catch {
      setQueue([]);
    }
  }, []);

  useEffect(() => {
    refresh();
    const guarded = () => {
      if (!dragging.current && Date.now() > settleUntil.current) {
        refresh();
      }
    };
    const sub = TrackPlayer.addEventListener(
      Event.PlaybackActiveTrackChanged,
      guarded,
    );
    // Shuffle reorders everything AFTER the active track and therefore never
    // fires PlaybackActiveTrackChanged — which is why turning shuffle on with
    // this list open visibly did nothing. The engine had shuffled; this was
    // rendering the array it read before.
    const off = onQueueChanged(guarded);
    return () => {
      sub.remove();
      off();
    };
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

  /**
   * A key per row, and it has to hold still across a reorder.
   *
   * `_qid` (player.ts) is the real answer: one id per queue INSTANCE, so five
   * copies of a song are five distinct rows. But a queue adopted from a service
   * that outlived the JS context carries none, and the fallback then decides
   * how those rows behave. An index-based one is the worst possible choice —
   * every row that moves gets a new key, so React unmounts and remounts it, and
   * the new <Image> and fresh layout show up as a pop exactly as the drop
   * settles.
   *
   * This numbers the OCCURRENCES of each song instead. A track that appears
   * once keeps `id#0` wherever it is dragged to; two copies of one song swap
   * their numbers when reordered, and swapping the keys of two identical rows
   * is invisible by definition.
   */
  const rowKeys = useMemo(() => {
    const seen = new Map<string, number>();
    return upcoming.map(t => {
      const qid = (t as {_qid?: string})._qid;
      if (qid) {
        return qid;
      }
      const base = String(t.id ?? t.url ?? 'x');
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return `${base}#${n}`;
    });
  }, [upcoming]);

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
      // Optimistic, and SYNCHRONOUS. DraggableFlatList's release animation
      // assumes the list already shows the new order the instant the finger
      // lifts; deferring this by a frame painted the OLD order once, so the row
      // snapped back to where it came from and then jumped to the drop point.
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
        // activeScale 1: the lift is carried by the shadow. A 3% scale is
        // barely visible going up and is the only thing still animating on the
        // way down, where it reads as the row settling twice.
        <ScaleDecorator activeScale={1}>
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

  // The context above the scroll region, always — including when there is
  // nothing queued. The empty state used to return INSTEAD of it, so the sheet
  // opened with no title on it at all.
  const head = (
    <View style={styles.head}>
      <Text style={styles.sheetTitle}>Queue</Text>
      {!!nowPlaying && (
        <View style={styles.subRow}>
          <Text style={styles.subtitle} numberOfLines={1}>
            Playing {splitArtists(String(nowPlaying.artist ?? ''))[0] || '—'}
          </Text>
          {!!output && (
            <>
              <Text style={styles.subDot}>·</Text>
              <Headphones size={11} color={C.accent} />
              <Text style={styles.subOutput} numberOfLines={1}>
                {output}
              </Text>
            </>
          )}
        </View>
      )}
    </View>
  );

  if (!queue.length) {
    return (
      <View style={styles.wrap}>
        {head}
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            Nothing queued. Autoplay will keep the music going when this ends.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {head}

      {/* PINNED: outside the list, so what is playing stays on screen however
          far down the queue you scroll. */}
      {!!nowPlaying && <Row track={nowPlaying} activeRow />}

      {upcoming.length > 0 && (
        <View style={styles.sectionRow}>
          {shuffled && <Shuffle size={12} color={C.sub} strokeWidth={2.4} />}
          <Text style={styles.section}>
            {shuffled ? 'Shuffling from' : 'Next up'}
          </Text>
        </View>
      )}

      <DraggableFlatList
        data={upcoming}
        keyExtractor={(_t, i) => rowKeys[i] ?? String(i)}
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
        // Tells the sheet above where this list is, so it only starts to
        // follow the finger once there is nothing left to scroll.
        onScrollOffsetChange={off => {
          if (scrollY) {
            scrollY.value = off;
          }
        }}
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
  // minHeight:0 on both so the list is free to be SHORTER than its content.
  // The sheet's definite height is what actually makes it scroll (see
  // queueSheet in PlayerScreen); these say the list may shrink into it.
  wrap: {flex: 1, minHeight: 0},
  listBox: {flex: 1, minHeight: 0},
  body: {paddingBottom: 16},
  head: {paddingHorizontal: S.gutter, paddingTop: 6, paddingBottom: 10},
  sheetTitle: {...T.screenTitle, color: C.text, fontSize: 20},
  subRow: {flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2},
  subtitle: {...T.sub, color: C.sub, fontSize: 12, flexShrink: 1},
  subDot: {color: C.faint, fontSize: 12},
  subOutput: {color: C.accent, fontSize: 12, fontWeight: '600', flexShrink: 1},
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: S.gutter,
    paddingTop: 12,
    paddingBottom: 6,
  },
  section: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: C.sub,
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
