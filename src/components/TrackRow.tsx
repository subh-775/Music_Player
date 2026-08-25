/**
 * One track line. Shared by Search, Library, albums and playlists so a track
 * looks and behaves the same everywhere in the app.
 *
 * Swiping the row to the RIGHT adds it to the queue — same gesture as the
 * WebView build. The responder claims only a clearly-horizontal rightward
 * drag, so taps and vertical list scrolling are untouched.
 */
import React, {useMemo, useRef} from 'react';
import {Image, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {Gesture, GestureDetector} from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import {
  ArrowDownToLine,
  Heart,
  ListPlus,
  MoreVertical,
} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {formatDuration, type Track} from '../backend';
import {cleanText, getBestArtworkUrl} from '../tracks';
import {useLike} from '../store';
import {addToQueue, useIsActiveTrack} from '../player';
import {useIsDownloaded} from '../downloads';
import {toast} from '../toast';
import {SourceBadge} from './Badges';

const SWIPE_COMMIT = 64;

/**
 * Windowing defaults for any long list of TrackRows.
 *
 * None were set anywhere in the app, so FlatList kept every row it had ever
 * rendered mounted and realised the whole list in one batch. Spread these onto
 * a list and it renders a screenful, then fills in as you scroll.
 *
 * Deliberately NOT getItemLayout: that needs an exact, guaranteed row height,
 * and a wrong number breaks scroll positioning in ways that are much worse than
 * the render cost it saves. These four are safe whatever the row measures.
 */
export const listWindowing = {
  removeClippedSubviews: true,
  initialNumToRender: 12,
  maxToRenderPerBatch: 8,
  windowSize: 7,
} as const;

/**
 * Memoised, and every store it reads is a BOOLEAN subscription.
 *
 * It was a plain component reading whole collections — useActiveTrack(),
 * useDownloadedIds(), useLike() — so every parent re-render re-rendered every
 * visible row, and one track change re-rendered all twenty of them. Now a row
 * re-renders when its own props change, or when its own highlight / liked /
 * downloaded answer actually flips.
 */
export const TrackRow = React.memo(function TrackRow({
  track,
  onPress,
  onLongPress,
  onMenu,
  index,
  active,
  /** Show the inline heart and download buttons. On by default; the queue and
   *  other tight lists turn them off to keep the row from getting crowded. */
  showActions = true,
}: {
  track: Track;
  onPress: () => void;
  onLongPress?: () => void;
  onMenu?: () => void;
  index?: number;
  /** True for the track that's currently playing. */
  active?: boolean;
  showActions?: boolean;
}) {
  const dur = formatDuration(track.duration_ms);
  const artwork = getBestArtworkUrl(track);
  const {liked, toggle} = useLike(track);
  // A small green tick marks anything already on disk — permanent until the
  // file is deleted (a disk scan drops the id).
  const downloaded = useIsDownloaded(track);

  // Every row knows for itself whether it's the song playing — callers kept
  // forgetting to pass `active`, and a list where the playing song isn't green
  // leaves the user hunting. The prop still wins when supplied.
  const engineActive = useIsActiveTrack(track.title, track.artist);
  const isActive = active ?? engineActive;

  const slide = useSharedValue(0);
  const trackRef = useRef(track);
  trackRef.current = track;

  const commitQueue = React.useCallback(() => {
    const t = trackRef.current;
    addToQueue(t)
      .then(() => toast(`Queued "${cleanText(t.title)}"`))
      .catch(() => toast('Nothing is playing yet'));
  }, []);

  /**
   * Swipe right to queue — recognised NATIVELY, which is the whole point.
   *
   * This was a PanResponder, and it lost a race it could not win. Its
   * `onMoveShouldSetPanResponder` predicate is evaluated in JavaScript, while
   * the parent FlatList's scroller is a native Android ScrollView that claims
   * the touch on the UI thread — and once a native scroll view has claimed a
   * gesture, PanResponder cannot take it back. On a slow drag JS kept up and
   * won; on a fast flick the scroller had already locked the touch stream.
   *
   * The old `dx > 14 && |dx| > |dy| * 2` ratio made it worse. Touch events
   * arrive at a fixed rate, so a fast flick's FIRST move event already carries
   * a big delta — dx 40, dy 25 fails `40 > 50` — while a slow drag's first
   * event is dx 6, dy 1 and sails through. That is literally "I have to move my
   * finger slowly".
   *
   * activeOffsetX/failOffsetY replace the ratio entirely: gesture-handler
   * evaluates them natively against the raw touch stream, so a 40px-per-frame
   * flick activates on its first event. failOffsetY is what still protects
   * vertical scrolling.
   */
  const swipe = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-1000, 15])
        .failOffsetY([-14, 14])
        .onUpdate(e => {
          slide.value = Math.max(0, Math.min(96, e.translationX * 0.6));
        })
        .onEnd(e => {
          if (e.translationX >= SWIPE_COMMIT) {
            runOnJS(commitQueue)();
          }
          slide.value = withSpring(0, {damping: 18, stiffness: 220});
        }),
    [slide, commitQueue],
  );

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{translateX: slide.value}],
  }));

  return (
    <GestureDetector gesture={swipe}>
      <View style={styles.swipeWrap}>
        {/* Revealed behind the row as it slides. A soft translucent green, not a
          solid slab — a slightly-draggy tap barely shows it, and a real swipe
          still reads clearly against the accent-tinted icon. */}
        <View style={styles.queueHintBg} pointerEvents="none">
          <View style={styles.queueHint}>
            <ListPlus size={22} color={C.accentBright} strokeWidth={2.4} />
          </View>
        </View>

        <Animated.View style={rowStyle}>
          <TouchableOpacity
            style={styles.row}
            activeOpacity={0.65}
            onPress={onPress}
            onLongPress={onLongPress}
            delayLongPress={350}>
            {index != null ? (
              <Text style={styles.index}>{index + 1}</Text>
            ) : artwork ? (
              <Image source={{uri: artwork}} style={styles.thumb} />
            ) : (
              <View style={[styles.thumb, styles.thumbFallback]} />
            )}

            <View style={styles.text}>
              <Text
                style={[styles.title, isActive && styles.titleActive]}
                numberOfLines={1}>
                {cleanText(track.title)}
              </Text>
              <View style={styles.metaLine}>
                <SourceBadge track={track} />
                <Text style={styles.sub} numberOfLines={1}>
                  {cleanText(track.artist)}
                  {dur ? `  ·  ${dur}` : ''}
                </Text>
              </View>
            </View>

            {showActions && downloaded && (
              <ArrowDownToLine size={15} color={C.accent} style={styles.dot} />
            )}

            {showActions && (
              <TouchableOpacity onPress={toggle} hitSlop={6} style={styles.act}>
                <Heart
                  size={18}
                  color={liked ? C.accent : C.faint}
                  fill={liked ? C.accent : 'transparent'}
                />
              </TouchableOpacity>
            )}

            {!!onMenu && (
              <TouchableOpacity
                onPress={onMenu}
                hitSlop={8}
                style={styles.menu}>
                <MoreVertical size={19} color={C.faint} />
              </TouchableOpacity>
            )}
          </TouchableOpacity>
        </Animated.View>
      </View>
    </GestureDetector>
  );
});

const styles = StyleSheet.create({
  swipeWrap: {justifyContent: 'center'},
  queueHintBg: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(29,185,84,0.16)',
  },
  queueHint: {
    position: 'absolute',
    left: S.gutter + 8,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: S.gutter,
    paddingVertical: 8,
    gap: 12,
    backgroundColor: C.bg,
  },
  thumb: {width: 52, height: 52, borderRadius: 6, backgroundColor: C.surface},
  thumbFallback: {backgroundColor: C.surfaceHi},
  index: {
    width: 52,
    textAlign: 'center',
    color: C.faint,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  text: {flex: 1, minWidth: 0},
  title: {...T.body, color: C.text},
  titleActive: {color: C.accent},
  metaLine: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3},
  sub: {...T.sub, color: C.sub, flex: 1},
  act: {paddingHorizontal: 5, paddingVertical: 6},
  menu: {paddingLeft: 3, paddingVertical: 6},
  dot: {marginRight: 2},
});
