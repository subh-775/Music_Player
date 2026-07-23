/**
 * The mini player above the bottom nav.
 *
 * Shows where the sound is going when it isn't the phone speaker — a headphone
 * glyph plus the device name — because "why is nothing coming out of my phone"
 * is answered by that line alone.
 *
 * Swiping it left or right skips, matching the gesture on the full player's
 * artwork, so the same motion means the same thing in both places.
 */
import React, {useMemo} from 'react';
import {
  Image,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  Bluetooth,
  Headphones,
  Heart,
  Pause,
  Play,
} from 'lucide-react-native';
import {C, S} from '../theme';
import {cleanText, getBestArtworkUrl} from '../tracks';
import {Marquee} from './Marquee';
import {
  State,
  skipNext,
  skipPrevious,
  sourceTrackFor,
  togglePlay,
  useActiveTrack,
  usePlaybackState,
  useProgress,
} from '../player';
import {useLike} from '../store';
import {useAudioOutput} from '../audioOutput';

const SWIPE_COMMIT = 56;

export function PlayerBar({onExpand}: {onExpand: () => void}) {
  const active = useActiveTrack();
  const {state} = usePlaybackState() as {state?: State};
  const {position, duration} = useProgress(1000);
  const output = useAudioOutput();

  const track = useMemo(() => sourceTrackFor(active), [active]);
  const {liked, toggle} = useLike(track);

  const pan = useMemo(
    () =>
      PanResponder.create({
        // CAPTURE, not the plain variant. The bar's contents are Touchables,
        // and a child that has already claimed the touch never hands it back —
        // which is why the swipe silently did nothing. Capturing lets the bar
        // take over the moment the movement is clearly horizontal, while a
        // straight tap still falls through to the child.
        onMoveShouldSetPanResponderCapture: (_e, g) =>
          Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        // No follow-the-finger travel. The bar is small and permanently on
        // screen, so any movement here reads as the UI coming loose rather
        // than as a gesture — the song simply changes.
        onPanResponderRelease: (_e, g) => {
          if (g.dx <= -SWIPE_COMMIT) {
            skipNext();
          } else if (g.dx >= SWIPE_COMMIT) {
            skipPrevious();
          }
        },
      }),
    [],
  );

  if (!active) {
    return null;
  }

  const playing = state === State.Playing;
  const artwork = track ? getBestArtworkUrl(track) : String(active.artwork ?? '');
  const pct = duration > 0 ? Math.min(1, position / duration) : 0;

  return (
    <View style={styles.wrap} {...pan.panHandlers}>
      {/* The BAR stays put; only its contents travel. Sliding the whole bar
          made the chrome look like it was falling off the screen every skip. */}
      <View style={styles.slider}>
      <TouchableOpacity
        style={styles.main}
        activeOpacity={0.85}
        onPress={onExpand}>
        {artwork ? (
          <Image source={{uri: artwork}} style={styles.art} />
        ) : (
          <View style={[styles.art, styles.artFallback]} />
        )}

        <View style={styles.text}>
          <Marquee
            text={cleanText(String(active.title ?? ''))}
            style={styles.title}
          />
          {output ? (
            <View style={styles.outputRow}>
              <Bluetooth size={11} color={C.accent} />
              <Text style={styles.output} numberOfLines={1}>
                {output}
              </Text>
            </View>
          ) : (
            <Text style={styles.artist} numberOfLines={1}>
              {cleanText(String(active.artist ?? ''))}
            </Text>
          )}
        </View>
      </TouchableOpacity>
      </View>

      <View style={styles.controls}>
        {!!output && <Headphones size={20} color={C.accent} />}

        <TouchableOpacity onPress={toggle} hitSlop={8} style={styles.ctl}>
          <Heart
            size={21}
            color={liked ? C.accent : C.sub}
            fill={liked ? C.accent : 'transparent'}
          />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => togglePlay()}
          hitSlop={8}
          style={styles.ctl}>
          {playing ? (
            <Pause size={24} color={C.text} fill={C.text} />
          ) : (
            <Play size={24} color={C.text} fill={C.text} />
          )}
        </TouchableOpacity>

      </View>

      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, {width: `${pct * 100}%`}]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 8,
    marginBottom: 6,
    borderRadius: 8,
    backgroundColor: C.surfaceHi,
    overflow: 'hidden',
  },
  slider: {flex: 1, minWidth: 0, flexDirection: 'row'},
  main: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 8,
    minWidth: 0,
  },
  art: {width: 44, height: 44, borderRadius: 4, backgroundColor: C.surface},
  artFallback: {backgroundColor: C.bg},
  text: {flex: 1, minWidth: 0},
  title: {fontSize: 13.5, fontWeight: '700', color: C.text},
  artist: {fontSize: 11.5, color: C.sub, marginTop: 2},
  outputRow: {flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2},
  output: {fontSize: 11.5, color: C.accent, flexShrink: 1},
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingRight: S.gutter - 8,
  },
  ctl: {padding: 5},
  progressTrack: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 2,
    height: 2,
    borderRadius: 1,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  progressFill: {height: '100%', borderRadius: 1, backgroundColor: C.text},
});
