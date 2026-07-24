/**
 * One track line. Shared by Search, Library, albums and playlists so a track
 * looks and behaves the same everywhere in the app.
 *
 * Swiping the row to the RIGHT adds it to the queue — same gesture as the
 * WebView build. The responder claims only a clearly-horizontal rightward
 * drag, so taps and vertical list scrolling are untouched.
 */
import React, {useRef} from 'react';
import {
  Animated,
  Image,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {Heart, ListPlus, MoreVertical} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {formatDuration, type Track} from '../backend';
import {cleanText, getBestArtworkUrl} from '../tracks';
import {useLike} from '../store';
import {addToQueue, useActiveTrack} from '../player';
import {toast} from '../toast';
import {SourceBadge} from './Badges';

const SWIPE_COMMIT = 64;

export function TrackRow({
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

  // Every row knows for itself whether it's the song playing — callers kept
  // forgetting to pass `active`, and a list where the playing song isn't green
  // leaves the user hunting. The prop still wins when supplied.
  const engineTrack = useActiveTrack();
  const isActive =
    active ??
    (!!engineTrack &&
      String(engineTrack.title ?? '').toLowerCase() ===
        (track.title || '').toLowerCase() &&
      String(engineTrack.artist ?? '').toLowerCase() ===
        (track.artist || '').toLowerCase());

  const slide = useRef(new Animated.Value(0)).current;
  const trackRef = useRef(track);
  trackRef.current = track;

  const pan = useRef(
    PanResponder.create({
      // Rightward and clearly horizontal, or it's not ours.
      onMoveShouldSetPanResponder: (_e, g) =>
        g.dx > 14 && Math.abs(g.dx) > Math.abs(g.dy) * 2,
      onPanResponderMove: (_e, g) =>
        slide.setValue(Math.max(0, Math.min(96, g.dx * 0.6))),
      onPanResponderRelease: (_e, g) => {
        if (g.dx >= SWIPE_COMMIT) {
          const t = trackRef.current;
          addToQueue(t)
            .then(() => toast(`Queued "${cleanText(t.title)}"`))
            .catch(() => toast('Nothing is playing yet'));
        }
        Animated.spring(slide, {toValue: 0, useNativeDriver: true, bounciness: 7}).start();
      },
      onPanResponderTerminate: () =>
        Animated.spring(slide, {toValue: 0, useNativeDriver: true}).start(),
    }),
  ).current;

  return (
    <View style={styles.swipeWrap} {...pan.panHandlers}>
      {/* Revealed behind the row as it slides — says what release will do. */}
      <View style={styles.queueHint} pointerEvents="none">
        <ListPlus size={20} color={C.accent} />
      </View>

      <Animated.View style={{transform: [{translateX: slide}]}}>
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
            <TouchableOpacity onPress={onMenu} hitSlop={8} style={styles.menu}>
              <MoreVertical size={19} color={C.faint} />
            </TouchableOpacity>
          )}
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  swipeWrap: {justifyContent: 'center'},
  queueHint: {
    position: 'absolute',
    left: S.gutter,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    height: '100%',
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
});
