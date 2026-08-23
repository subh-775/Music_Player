/**
 * The mini player above the bottom nav.
 *
 * Shows where the sound is going when it isn't the phone speaker — a headphone
 * glyph plus the device name — because "why is nothing coming out of my phone"
 * is answered by that line alone.
 *
 * Swiping it left or right skips, matching the gesture on the full player's
 * artwork, so the same motion means the same thing in both places.
 *
 * ## What makes it read as a floating bar rather than a toolbar
 *
 * Four things, and they are all finishing rather than layout:
 *
 *   - It has ELEVATION. A background and a radius with no shadow sits flat
 *     against the page; a bar that floats has to look like it does.
 *   - The fill is a vertical GRADIENT, lighter at the top where the light is.
 *     One solid darkened colour is the flattest a surface can look.
 *   - The corners are CONCENTRIC: outer radius = inner radius + padding. Bar
 *     and artwork were both 8, which is what made it read as two rectangles
 *     that happen to overlap.
 *   - One control DOMINATES. Three glyphs at the same optical weight in three
 *     identical slots is a toolbar. Play is what the bar is for, so it gets a
 *     solid disc and the others do not.
 */
import React, {useCallback, useMemo} from 'react';
import {Image, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {Gesture, GestureDetector} from 'react-native-gesture-handler';
import Animated, {
  SlideInDown,
  SlideOutDown,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, {Defs, LinearGradient, Rect, Stop} from 'react-native-svg';
import {Bluetooth, Heart, Pause, Play} from 'lucide-react-native';
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

/** Concentric corners: PAD + ART_R = BAR_R, so the two curves are parallel. */
const PAD = 5;
const ART_R = 6;
const BAR_R = PAD + ART_R;

/**
 * The hairline under the mini player, and the only part of it on a clock.
 *
 * PlayerBar is mounted above ALL THREE tabs for the life of the app, so
 * subscribing to progress in the bar itself meant a 1Hz re-render of a
 * component containing a Marquee, forever, on every screen. Here it re-renders
 * one 2px view.
 */
const MiniProgress = React.memo(function MiniProgress() {
  const {position, duration} = useProgress(1000);
  const pct = duration > 0 ? Math.min(1, position / duration) : 0;
  return <View style={[styles.progressFill, {width: `${pct * 100}%`}]} />;
});

export function PlayerBar({onExpand}: {onExpand: () => void}) {
  const active = useActiveTrack();
  const playing = useIsPlaying();
  const output = useAudioOutput();

  const track = useMemo(() => sourceTrackFor(active), [active]);
  const {liked, toggle} = useLike(track);

  // Only the TITLE slides — the artwork just swaps to the new song, per the
  // request. And the skip is fired IMMEDIATELY, not behind the animation, so
  // the new song appears at once instead of a beat later.
  const titleSlide = useSharedValue(0);
  /** Whole-bar press feedback. Tiny, and it is what connects the tap to the
   *  expansion that follows — without it the bar feels like a static strip. */
  const press = useSharedValue(0);

  const commit = useCallback(
    (dir: 1 | -1) => {
      // Fire the skip NOW — the engine advances while this animates.
      (dir === 1 ? skipNext() : skipPrevious()).catch(() => {});
      titleSlide.value = dir * 90;
      titleSlide.value = withTiming(0, {duration: 220});
    },
    [titleSlide],
  );

  /**
   * Recognised natively.
   *
   * This used `onMoveShouldSetPanResponderCapture` — a CAPTURE handler, which
   * intercepts touches on the way down and can take one from a child Touchable
   * that was about to handle it. It was there because the plain variant could
   * never win against the bar's own buttons. activeOffsetX needs neither trick:
   * a stationary press goes to whichever button is under it, and a horizontal
   * drag is claimed the moment it is unambiguously horizontal.
   */
  const swipe = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-14, 14])
        .failOffsetY([-18, 18])
        .onEnd((e, success) => {
          if (!success) {
            return;
          }
          if (e.translationX <= -SWIPE_COMMIT) {
            runOnJS(commit)(1);
          } else if (e.translationX >= SWIPE_COMMIT) {
            runOnJS(commit)(-1);
          }
        }),
    [commit],
  );

  const titleStyle = useAnimatedStyle(() => ({
    transform: [{translateX: titleSlide.value}],
  }));
  const barStyle = useAnimatedStyle(() => ({
    transform: [{scale: 1 - press.value * 0.015}],
  }));

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

  return (
    /* Rises in rather than appearing. The bar arrives when the first song
       starts, which is a change worth showing rather than blinking.

       Its own view, OUTSIDE the GestureDetector on purpose: an exiting
       animation needs the animated view to outlive its parent for the length of
       the exit, and it cannot do that if an ancestor is unmounting in the same
       commit. */
    <Animated.View
      entering={SlideInDown.duration(240)}
      exiting={SlideOutDown.duration(180)}>
      <GestureDetector gesture={swipe}>
        <Animated.View style={[styles.wrap, barStyle]}>
          {/* A vertical gradient, not a flat fill: lighter at the top where the
            light would be. Falls back to the flat surface when the artwork's
            colour isn't known yet, which is a beat at most. */}
          {!!tint && (
            <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
              <Defs>
                <LinearGradient id="barFill" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={toward(tint, 0.34)} />
                  <Stop offset="1" stopColor={toward(tint, 0.58)} />
                </LinearGradient>
              </Defs>
              <Rect width="100%" height="100%" fill="url(#barFill)" />
            </Svg>
          )}

          {/* The BAR and ARTWORK stay put; only the title travels. */}
          <View style={styles.slider}>
            <TouchableOpacity
              style={styles.main}
              activeOpacity={1}
              onPressIn={() => {
                press.value = withTiming(1, {duration: 90});
              }}
              onPressOut={() => {
                press.value = withTiming(0, {duration: 160});
              }}
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

              <Animated.View style={[styles.text, titleStyle]}>
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

          {/* Like, then play. The headphone glyph that used to hold a third slot
            here is gone: it is STATUS, not an action, and it already has a home
            in the subtitle line above. Dropping the slot also hands the title
            40px it did not have. */}
          <View style={styles.controls}>
            <TouchableOpacity onPress={toggle} hitSlop={10} style={styles.ctl}>
              <Heart
                size={21}
                color={liked ? C.accent : C.text}
                fill={liked ? C.accent : 'transparent'}
                strokeWidth={2}
              />
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => togglePlay()}
              activeOpacity={0.85}
              hitSlop={8}
              style={styles.playBtn}>
              {playing ? (
                <Pause size={20} color={C.bg} fill={C.bg} />
              ) : (
                <Play
                  size={20}
                  color={C.bg}
                  fill={C.bg}
                  style={styles.playNudge}
                />
              )}
            </TouchableOpacity>
          </View>

          <View style={styles.progressTrack}>
            <MiniProgress />
          </View>
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 8,
    marginBottom: 6,
    borderRadius: BAR_R,
    backgroundColor: C.surfaceHi,
    overflow: 'hidden',
    // Elevation is what makes it float. Without it the bar is a coloured
    // rectangle lying flat on the page.
    elevation: 10,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 14,
    shadowOffset: {width: 0, height: 6},
    // Catches light along the top edge, which is what separates the bar from
    // whatever is scrolling behind it.
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.07)',
  },
  slider: {flex: 1, minWidth: 0, flexDirection: 'row'},
  main: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: PAD,
    minWidth: 0,
  },
  art: {
    width: 54,
    height: 54,
    borderRadius: ART_R,
    backgroundColor: C.surface,
    // Stops a cover with a light background from bleeding into the bar.
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.09)',
  },
  artFallback: {backgroundColor: C.bg},
  text: {flex: 1, minWidth: 0},
  // 14/600 over 11.5/400-at-62%. The old pair was 13/700 and 12/400 — one pixel
  // apart, which is no hierarchy at all. The contrast gap does more work here
  // than the size gap.
  title: {fontSize: 14, fontWeight: '600', color: C.text, letterSpacing: 0.1},
  artist: {fontSize: 11.5, color: C.text, opacity: 0.62, marginTop: 2},
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
    paddingRight: S.gutter - 8,
  },
  ctl: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // A solid disc with a dark glyph — the one control that outranks everything
  // else on the bar, and the only filled shape on it.
  playBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: C.text,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,
  },
  playNudge: {marginLeft: 2}, // optical centring for the triangle
  progressTrack: {
    position: 'absolute',
    // Inset, so it stops clipping against the bar's rounded corners.
    left: 12,
    right: 12,
    bottom: 4,
    height: 2.5,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
    // Not pure white: at the very bottom edge of a coloured bar, C.text read as
    // a second, brighter border rather than as progress.
    backgroundColor: 'rgba(255,255,255,0.85)',
  },
});
