/**
 * What's playing and what's next. Tap a row to jump; drag the grip to reorder.
 *
 * Reads the engine's real queue rather than a copy held in JS, so it can't
 * drift from what will actually play.
 *
 * ## Why the drag is built this way
 *
 * The first version of this called `setDragOver(...)` on every pan frame, so
 * every finger movement re-rendered the whole list to recompute which rows
 * should slide. That is what made it "laggy and stubborn", and it is also where
 * the overlapping rows came from — React repainting rows mid-gesture while an
 * absolute-positioned dragged row floated over them.
 *
 * There is no per-frame state here at all. ONE `Animated.Value` tracks the
 * finger, and every other row derives its offset from it as an interpolation —
 * a step function with a short transition band, so rows slide out of the way as
 * the dragged item crosses their midpoint. React renders twice per gesture:
 * once when the drag starts, once when it ends.
 *
 * ## Only upcoming tracks reorder
 *
 * The playing track is pinned at the top and cannot be dragged, and nothing can
 * be dropped above it. RNTP's remove() maps to ExoPlayer's removeMediaItem, and
 * removing the item that is currently playing stops playback — so a queue where
 * the active row was draggable could kill the music mid-drag. This also matches
 * the reference build, whose `queue` array is upcoming-only.
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
import {Event, TrackPlayer, moveQueueItem, sourceTrackFor} from '../player';

const ROW_H = 60;
/** Half-width of the slide transition, in px. Small = snappy, large = mushy. */
const BAND = 14;

export function QueuePane() {
  const [queue, setQueue] = useState<RNTPTrack[]>([]);
  const [active, setActive] = useState<number | null>(null);
  /** Index INTO `upcoming` of the row being dragged, or null. */
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  const dragY = useRef(new Animated.Value(0)).current;
  const dragDy = useRef(0);
  // A drop writes the new order straight into `queue`; the engine round-trip
  // that follows must not be allowed to paint the old order back over it.
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
    // Event-driven, never polled: a timer here was what made a just-dropped
    // reorder appear to take a beat to settle.
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

  /** Where the autoplay-radio tail begins, as an index into `upcoming`. */
  const firstRecommended = useMemo(
    () => upcoming.findIndex(t => sourceTrackFor(t)?._autoplay),
    [upcoming],
  );

  /**
   * Commit a reorder. The list is updated optimistically so the row lands under
   * the finger with no wait, then the engine is brought into line.
   */
  const commitMove = useCallback(
    async (fromJ: number, toJ: number) => {
      if (fromJ === toJ || activeIdx < 0) {
        return;
      }
      settleUntil.current = Date.now() + 2000;
      setQueue(prev => {
        const next = [...prev];
        const [moved] = next.splice(activeIdx + 1 + fromJ, 1);
        next.splice(activeIdx + 1 + toJ, 0, moved);
        return next;
      });
      const ok = await moveQueueItem(activeIdx + 1 + fromJ, activeIdx + 1 + toJ);
      if (!ok) {
        settleUntil.current = 0;
        refresh(); // engine refused — show the truth rather than a lie
      }
    },
    [activeIdx, refresh],
  );

  // Responders must be STABLE across renders: the drag start re-renders, and
  // handing the row a freshly-built responder mid-gesture orphans the gesture
  // (the old "I dragged it and it snapped back" bug). One per index, forever,
  // reading current values through refs.
  const upcomingLen = useRef(0);
  upcomingLen.current = upcoming.length;
  const commitRef = useRef(commitMove);
  commitRef.current = commitMove;
  const responders = useRef(
    new Map<number, ReturnType<typeof PanResponder.create>>(),
  );

  const gripHandlers = useCallback(
    (index: number) => {
      let r = responders.current.get(index);
      if (!r) {
        r = PanResponder.create({
          onStartShouldSetPanResponder: () => true,
          onMoveShouldSetPanResponder: () => true,
          // The ScrollView must not steal the gesture once the grip has it.
          onPanResponderTerminationRequest: () => false,
          onPanResponderGrant: () => {
            dragY.setValue(0);
            dragDy.current = 0;
            setDragFrom(index);
          },
          // setValue, NOT setState — this moves the row without re-rendering.
          onPanResponderMove: (_e, g) => {
            dragDy.current = g.dy;
            dragY.setValue(g.dy);
          },
          onPanResponderRelease: () => {
            const to = Math.max(
              0,
              Math.min(
                upcomingLen.current - 1,
                index + Math.round(dragDy.current / ROW_H),
              ),
            );
            setDragFrom(null);
            dragY.setValue(0);
            commitRef.current(index, to);
          },
          onPanResponderTerminate: () => {
            setDragFrom(null);
            dragY.setValue(0);
          },
        });
        responders.current.set(index, r);
      }
      return r.panHandlers;
    },
    [dragY],
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

  const nowPlaying = active == null ? null : queue[active];

  return (
    <ScrollView
      style={styles.wrap}
      contentContainerStyle={styles.body}
      scrollEnabled={dragFrom === null}
      showsVerticalScrollIndicator={false}>
      {!!nowPlaying && (
        <>
          <Text style={styles.section}>Now playing</Text>
          <Row track={nowPlaying} activeRow />
        </>
      )}

      {upcoming.length > 0 && (
        <Text style={styles.section}>Next up · hold the grip to reorder</Text>
      )}

      {upcoming.map((t, j) => (
        <Row
          key={String(t.id ?? t.url ?? j)}
          track={t}
          onPress={() => jump(activeIdx + 1 + j)}
          grip={gripHandlers(j)}
          offset={offsetFor(j, dragFrom, dragY)}
          lifted={dragFrom === j}
          // Radio picks are marked on the row itself rather than with a section
          // divider. A divider would make the list rows non-uniform in height,
          // and the drag maths (dy / ROW_H, and the step midpoints) depends on
          // every row being exactly ROW_H tall — an inserted header would put
          // every drop below it one slot out.
          recommended={firstRecommended >= 0 && j >= firstRecommended}
        />
      ))}
    </ScrollView>
  );
}

/**
 * How far row `j` should sit from its resting place, as an Animated node.
 *
 * The dragged row follows the finger 1:1. Every other row is a step: it slides
 * one row-height out of the way once the dragged item has crossed its midpoint.
 * `extrapolate: 'clamp'` is what keeps it a step rather than a slope, and the
 * ±BAND window is the short slide that makes the gap open smoothly.
 */
function offsetFor(
  j: number,
  from: number | null,
  dragY: Animated.Value,
): Animated.AnimatedInterpolation<number> | Animated.Value | number {
  if (from === null) {
    return 0;
  }
  if (j === from) {
    return dragY; // the picked-up row tracks the finger
  }
  if (j > from) {
    const mid = (j - from) * ROW_H - ROW_H / 2;
    return dragY.interpolate({
      inputRange: [mid - BAND, mid + BAND],
      outputRange: [0, -ROW_H],
      extrapolate: 'clamp',
    });
  }
  const mid = (j - from) * ROW_H + ROW_H / 2;
  return dragY.interpolate({
    inputRange: [mid - BAND, mid + BAND],
    outputRange: [ROW_H, 0],
    extrapolate: 'clamp',
  });
}

function Row({
  track: t,
  onPress,
  grip,
  offset = 0,
  lifted = false,
  activeRow = false,
  recommended = false,
}: {
  track: RNTPTrack;
  onPress?: () => void;
  grip?: object;
  offset?: Animated.AnimatedInterpolation<number> | Animated.Value | number;
  lifted?: boolean;
  activeRow?: boolean;
  recommended?: boolean;
}) {
  return (
    <Animated.View
      style={[
        styles.row,
        lifted && styles.rowLifted,
        {transform: [{translateY: offset}]},
      ]}
      // The picked-up row must not swallow touches, or the ScrollView below it
      // never sees the gesture end cleanly.
      pointerEvents={lifted ? 'none' : 'auto'}>
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

      {!!grip && (
        <View style={styles.grip} {...grip}>
          <Menu size={19} color={C.faint} />
        </View>
      )}
    </Animated.View>
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
    backgroundColor: C.bg,
  },
  rowLifted: {backgroundColor: C.surfaceHi, elevation: 8, zIndex: 5},
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
  emptyText: {color: C.faint, fontSize: 13, textAlign: 'center', lineHeight: 19},
});
