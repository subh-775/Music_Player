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
import React, {useMemo, useRef} from 'react';
import {
  Animated,
  Image,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {Bluetooth, Headphones, Heart, Pause, Play} from 'lucide-react-native';
import {C, S} from '../theme';
import {cleanText, getBestArtworkUrl} from '../tracks';
import {Marquee} from './Marquee';
import {
  skipNext,
  skipPrevious,
  sourceTrackFor,
  togglePlay,
  useActiveTrack,
  useIsPlaying,
  useProgress,
} from '../player';
import {useLike} from '../store';
import {useAudioOutput} from '../audioOutput';
import {toward, useArtworkColor} from '../artworkColor';

const SWIPE_COMMIT = 56;

export function PlayerBar({onExpand}: {onExpand: () => void}) {
  const active = useActiveTrack();
  const playing = useIsPlaying();
  const {position, duration} = useProgress(1000);
  const output = useAudioOutput();

  const track = useMemo(() => sourceTrackFor(active), [active]);
  const {liked, toggle} = useLike(track);

  // Only the TITLE slides — the artwork just swaps to the new song, per the
  // request. And the skip is fired IMMEDIATELY, not behind the animation, so
  // the new song appears at once instead of a beat later.
  const titleSlide = useRef(new Animated.Value(0)).current;

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
        onPanResponderRelease: (_e, g) => {
          const commit = (dir: 1 | -1, go: () => void) => {
            go(); // fire the skip NOW — the engine advances while this animates
            titleSlide.setValue(dir * 90);
            Animated.timing(titleSlide, {
              toValue: 0,
              duration: 220,
              useNativeDriver: true,
            }).start();
          };
          if (g.dx <= -SWIPE_COMMIT) {
            commit(1, skipNext);
          } else if (g.dx >= SWIPE_COMMIT) {
            commit(-1, skipPrevious);
          }
        },
      }),
    [titleSlide],
  );

  const artworkForColor = track
    ? getBestArtworkUrl(track)
    : String(active?.artwork ?? '');
  // The bar takes on the song's colour, darkened enough that the white text
  // keeps its contrast — same trick as the WebView build.
  const tint = useArtworkColor(artworkForColor || undefined);

  if (!active) {
    return null;
  }

  const artwork = artworkForColor;
  const pct = duration > 0 ? Math.min(1, position / duration) : 0;

  return (
    <View
      style={[styles.wrap, !!tint && {backgroundColor: toward(tint, 0.45)}]}
      {...pan.panHandlers}>
      {/* The BAR and ARTWORK stay put; only the title travels. */}
      <View style={styles.slider}>
        <TouchableOpacity
          style={styles.main}
          activeOpacity={0.85}
          onPress={onExpand}>
          {artwork ? (
            <Image
              key={artwork}
              source={{uri: artwork}}
              style={styles.art}
              fadeDuration={0}
            />
          ) : (
            <View style={[styles.art, styles.artFallback]} />
          )}

          <Animated.View
            style={[styles.text, {transform: [{translateX: titleSlide}]}]}>
            <Marquee
              text={cleanText(String(active.title ?? ''))}
              style={styles.title}
            />
            {output ? (
              <View style={styles.outputRow}>
                <Bluetooth size={10} color={C.accent} />
                <Text style={styles.output} numberOfLines={1}>
                  {output}
                </Text>
              </View>
            ) : (
              <Text style={styles.artist} numberOfLines={1}>
                {cleanText(String(active.artist ?? ''))}
              </Text>
            )}
          </Animated.View>
        </TouchableOpacity>
      </View>

      {/* Headphones, like, play — evenly spaced and all on the same optical
          size. The headphone glyph keeps its slot even when it isn't shown, so
          the other two don't shuffle sideways the moment a headset connects. */}
      <View style={styles.controls}>
        <View style={styles.ctl}>
          {!!output && (
            <Headphones size={22} color={C.accent} strokeWidth={2} />
          )}
        </View>

        <TouchableOpacity onPress={toggle} hitSlop={10} style={styles.ctl}>
          <Heart
            size={22}
            color={liked ? C.accent : C.text}
            fill={liked ? C.accent : 'transparent'}
            strokeWidth={2}
          />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => togglePlay()}
          hitSlop={10}
          style={styles.ctl}>
          {playing ? (
            <Pause size={26} color={C.text} fill={C.text} />
          ) : (
            <Play
              size={26}
              color={C.text}
              fill={C.text}
              style={styles.playNudge}
            />
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
    // Tight, even gap on all sides — the artwork now fills almost the whole
    // bar height instead of sitting in an 8px frame.
    padding: 5,
    minWidth: 0,
  },
  art: {width: 54, height: 54, borderRadius: 8, backgroundColor: C.surface},
  artFallback: {backgroundColor: C.bg},
  text: {flex: 1, minWidth: 0},
  title: {fontSize: 13, fontWeight: '700', color: C.text, letterSpacing: 0.1},
  artist: {fontSize: 12, color: C.sub, marginTop: 1.5},
  outputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3.5,
    marginTop: 2,
  },
  output: {fontSize: 10.5, fontWeight: '600', color: C.accent, flexShrink: 1},
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: S.gutter - 10,
  },
  // Fixed-width slots, so the three sit on an even rhythm and nothing shifts
  // when the headphone glyph appears or disappears.
  ctl: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playNudge: {marginLeft: 2}, // optical centring for the triangle
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
