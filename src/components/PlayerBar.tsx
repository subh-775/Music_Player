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
 *   - The three controls share ONE slot size and one optical weight. Play used
 *     to sit in a filled disc so it would dominate; at 38px the circle is
 *     heavier than the bar it lives on, and it made the three controls read as
 *     three different KINDS of control rather than one row.
 */
import React, {useCallback, useEffect, useMemo, useRef} from 'react';
import {Image, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {Gesture, GestureDetector} from 'react-native-gesture-handler';
import Animated, {
  SlideInDown,
  SlideOutDown,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, {Defs, LinearGradient, Rect, Stop} from 'react-native-svg';
import {Headphones, Pause, Play} from 'lucide-react-native';
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
import {useAudioOutput} from '../audioOutput';
import {
  EXPAND_GRAB,
  MINI_ART_RADIUS,
  bigArt,
  closedY,
  miniArt,
  miniBarOpacity,
  sheetY,
} from '../playerSheet';
import type {Track} from '../backend';
import {AddButton} from './AddButton';
import {toward, useArtworkColor} from '../artworkColor';

const SWIPE_COMMIT = 56;

/** Concentric corners: PAD + ART_R = BAR_R, so the two curves are parallel.
 *  ART_R comes from playerSheet because the full player's cover has to round
 *  DOWN to exactly this value as it morphs into the slot below. */
const PAD = 5;
const ART_R = MINI_ART_RADIUS;
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

/**
 * Memoised, and this is not a micro-optimisation.
 *
 * App holds twenty-odd useState hooks in ONE component, and all three tab
 * screens, the full player, the mini player and the drawer are its children —
 * so opening a sheet, closing an overlay or touching any of them re-rendered
 * every one of these trees. That is what "the app freezes for a moment" was:
 * not work being done, but work being redone. Every prop below is
 * useCallback-stable in App, so this actually holds.
 */
export const PlayerBar = React.memo(function PlayerBar({
  onExpand,
  onBeginExpandDrag,
  onEndExpandDrag,
  onAddToPlaylist,
}: {
  onExpand: () => void;
  /** A pull UP has started: mount the full player without animating it, so the
   *  finger can drive it the rest of the way. Mirrors the drawer's own
   *  begin/end pair. */
  onBeginExpandDrag: () => void;
  onEndExpandDrag: (open: boolean, velocity: number) => void;
  onAddToPlaylist: (t: Track) => void;
}) {
  const active = useActiveTrack();
  const playing = useIsPlaying();
  const output = useAudioOutput();

  const track = useMemo(() => sourceTrackFor(active), [active]);

  /**
   * How far the bar's contents are dragged, in pixels.
   *
   * It follows the FINGER now. This used to be written only on commit, so the
   * bar sat perfectly still through the whole swipe and then flicked to the new
   * song once the finger lifted — which is why a gesture had to be completed
   * blind before anything acknowledged it. The same value carries the settle
   * afterwards, so the release continues the motion the drag started instead of
   * being a second, separate animation.
   */
  const dragX = useSharedValue(0);
  /** Whole-bar press feedback. Tiny, and it is what connects the tap to the
   *  expansion that follows — without it the bar feels like a static strip. */
  const press = useSharedValue(0);

  const commit = useCallback(
    (dir: 1 | -1) => {
      // Fire the skip NOW — the engine advances while this animates.
      (dir === 1 ? skipNext() : skipPrevious()).catch(() => {});
      // Jump to the far side with no animation, then travel back in, so the
      // incoming song enters from the direction the finger was heading rather
      // than springing back from where it was released.
      dragX.value = dir * 90;
      dragX.value = withTiming(0, {duration: 220});
    },
    [dragX],
  );

  /** Let go without committing: back to rest, carrying the finger's speed. */
  const release = useCallback(() => {
    dragX.value = withSpring(0, {
      damping: 20,
      stiffness: 220,
      overshootClamping: true,
    });
  }, [dragX]);

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
        .onUpdate(e => {
          // Damped at 0.6, the same feel as the full player's artwork: the row
          // tracks the thumb without travelling the whole width of the screen,
          // so a small swipe still reads as a small swipe.
          dragX.value = e.translationX * 0.6;
        })
        .onEnd((e, success) => {
          if (success && e.translationX <= -SWIPE_COMMIT) {
            runOnJS(commit)(1);
            return;
          }
          if (success && e.translationX >= SWIPE_COMMIT) {
            runOnJS(commit)(-1);
            return;
          }
          runOnJS(release)();
        }),
    [commit, release, dragX],
  );

  /**
   * Pull UP to open the full player, under the finger.
   *
   * The tap still works and is still the common case — this is for the drag,
   * which used to do nothing at all, so the panel could only ever appear on its
   * own schedule after the gesture had finished. Writing `sheetY` directly is
   * what makes the cover grow out of this slot as the thumb travels: the full
   * player's whole morph is a function of that one value, so the two are the
   * same motion rather than two animations that happen to agree.
   *
   * UPWARD only, and it fails on horizontal travel so the skip swipe above
   * keeps its claim. The two are raced rather than nested: whichever the finger
   * commits to first wins outright, at the same threshold on both axes.
   *
   * ## Why the drag starts at `closedY` and not a whole screen down
   *
   * The sheet's closed position is a whole screen height down; the distance
   * over which the cover actually changes size is the shorter `spanBetween`.
   * Starting the drag a full screen down meant the first ~390px of a pull moved
   * the panel while changing nothing anyone could see — the backdrop is still
   * fully transparent up there and the cover is still parked on top of the real
   * mini player — so the gesture felt dead until it suddenly committed.
   *
   * Starting at the span looks identical at rest (everything above it is
   * invisible anyway) and maps the whole pull onto the part that is visible:
   * the cover begins growing on the first pixel of travel.
   */
  const pullUp = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-EXPAND_GRAB, 1000])
        .failOffsetX([-EXPAND_GRAB, EXPAND_GRAB])
        .onStart(() => {
          sheetY.value = closedY();
          runOnJS(onBeginExpandDrag)();
        })
        .onUpdate(e => {
          // translationY is negative going up, so adding it walks the sheet
          // toward 0 — fully open. Clamped at both ends so pushing past the
          // top does not overshoot into a gap above the panel.
          const from = closedY();
          sheetY.value = Math.min(from, Math.max(0, from + e.translationY));
        })
        .onEnd((e, success) => {
          // A third of the way, or a firm flick. Anything less goes back — a
          // gesture you abandoned must not commit.
          const from = closedY();
          const open =
            success && (-e.translationY > from * 0.3 || e.velocityY < -700);
          runOnJS(onEndExpandDrag)(open, e.velocityY);
        }),
    [onBeginExpandDrag, onEndExpandDrag],
  );

  const barGesture = useMemo(
    () => Gesture.Race(pullUp, swipe),
    [pullUp, swipe],
  );

  /**
   * Publish where this cover sits, in window coordinates, for the morph to aim
   * at. Measured rather than computed: the bar floats over the page at a height
   * that depends on the navigation bar, so there is no constant for it.
   */
  const artRef = useRef<View>(null);
  const measureMiniArt = useCallback(() => {
    // The swipe offset is subtracted back out for the same reason the player
    // subtracts its sheet offset: measureInWindow reports the view WITH its
    // transform, and what the morph needs to aim at is where this square sits
    // at REST, not where a half-finished swipe has pushed it.
    const at = dragX.value;
    artRef.current?.measureInWindow((x, y, w) => {
      if (w > 0) {
        miniArt.value = {x: x - at, y, size: w};
      }
    });
  }, [dragX]);

  /**
   * Measure again once the bar has finished ARRIVING.
   *
   * onLayout alone is not enough here: the bar enters with SlideInDown, so the
   * first layout is reported while it is still travelling up from below the
   * screen, and `measureInWindow` reports the transform. That would aim the
   * morph at a point off the bottom of the display, and nothing would ever fire
   * onLayout again to correct it — the bar's layout does not change for the
   * rest of the session.
   *
   * 300 clears the 240ms entrance with room to spare. One timer, once, when the
   * first song starts.
   */
  useEffect(() => {
    const t = setTimeout(measureMiniArt, 300);
    return () => clearTimeout(t);
  }, [measureMiniArt]);

  /**
   * The whole row travels, not just the title.
   *
   * The artwork used to stay nailed in place while the words moved, which reads
   * as two unrelated things rather than as one song being dragged aside. It
   * stays put during the MORPH — that is a different motion with a different
   * job — but a sideways swipe moves the cover with everything else.
   */
  const slideStyle = useAnimatedStyle(() => ({
    transform: [{translateX: dragX.value}],
  }));

  /**
   * The bar fades in on the tail of the morph — see `miniBarOpacity`, which
   * owns the rule and the guard that stops this bar ever vanishing outright.
   *
   * All three shared values are read HERE, in the style's own body, because
   * that is the only place Reanimated looks when deciding what this style
   * depends on. Reading them inside the helper instead would leave the opacity
   * computed once and never updated again.
   */
  const barFade = useAnimatedStyle(() => ({
    opacity: miniBarOpacity(miniArt.value, bigArt.value, sheetY.value),
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
      <GestureDetector gesture={barGesture}>
        <Animated.View style={[styles.wrap, barStyle, barFade]}>
          {/* A vertical gradient, not a flat fill: lighter at the top where the
            light would be. Falls back to the flat surface when the artwork's
            colour isn't known yet, which is a beat at most. */}
          {!!tint && (
            <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
              <Defs>
                <LinearGradient id="barFill" x1="0" y1="0" x2="0" y2="1">
                  {/* Darker than it was: the bar is translucent now and sits
                      over live content, so the tint has to hold its own
                      surface rather than glow. */}
                  <Stop offset="0" stopColor={toward(tint, 0.52)} />
                  <Stop offset="1" stopColor={toward(tint, 0.7)} />
                </LinearGradient>
              </Defs>
              <Rect width="100%" height="100%" fill="url(#barFill)" />
            </Svg>
          )}

          {/* Artwork and text travel together under the finger. */}
          <Animated.View style={[styles.slider, slideStyle]}>
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
              {/* The wrapper is what the morph aims at — one rect whether
                  there is a cover or a placeholder, and a plain View so
                  measureInWindow has something stable to report.

                  The URL here is deliberately the PLAYER-size cover, not the
                  thumb a 54dp square would otherwise want. Sharing one URL
                  with the full player is what lets the morph hand over a
                  decoded bitmap instead of starting a fetch at the exact
                  moment the panel opens — so this is load-bearing, not an
                  oversight to tidy up later. */}
              <View
                ref={artRef}
                onLayout={measureMiniArt}
                style={styles.art}
                collapsable={false}>
                {artwork ? (
                  <Image
                    key={artwork}
                    source={{uri: artwork}}
                    style={styles.artFill}
                    fadeDuration={0}
                  />
                ) : (
                  <View style={[styles.artFill, styles.artFallback]} />
                )}
              </View>

              <View style={styles.text}>
                <Marquee
                  text={cleanText(String(active.title ?? ''))}
                  style={styles.title}
                />
                {output ? (
                  // The name only. The 10px glyph that used to sit beside it
                  // has moved into the controls at control size, which is where
                  // it is actually legible.
                  <Text style={styles.output} numberOfLines={1}>
                    {output}
                  </Text>
                ) : (
                  <Text style={styles.artist} numberOfLines={1}>
                    {cleanText(String(active.artist ?? ''))}
                  </Text>
                )}
              </View>
            </TouchableOpacity>
          </Animated.View>

          {/* Output, like, play — three identical 38x38 slots, so the row reads
            as one rhythm instead of three different shapes. The headphones are
            STATUS rather than an action, which is why they are a bare View: no
            press feedback on something that cannot be pressed. They appear only
            when something is actually connected, so they cost nothing the rest
            of the time. */}
          <View style={styles.controls}>
            {!!output && (
              <View style={styles.ctl}>
                <Headphones size={24} color={C.accent} strokeWidth={2} />
              </View>
            )}

            {/* The same control as the full player, so the two can never
                disagree about what a press does. */}
            <AddButton
              track={track}
              onOpenSheet={onAddToPlaylist}
              size={23}
              hitSlop={10}
              style={styles.ctl}
            />

            <TouchableOpacity
              onPress={() => togglePlay()}
              activeOpacity={0.85}
              hitSlop={8}
              style={styles.playBtn}>
              {playing ? (
                <Pause size={26} color={C.text} fill={C.text} />
              ) : (
                <Play size={26} color={C.text} fill={C.text} />
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
});

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 10,
    marginBottom: 4,
    borderRadius: BAR_R,
    // Translucent, not opaque. Against the fade at the foot of the page this
    // is what makes the bar read as sitting ABOVE the content rather than
    // being punched into it, and it costs nothing — no blur pass, no library.
    backgroundColor: 'rgba(38,38,38,0.9)',
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
    borderColor: 'rgba(255,255,255,0.1)',
  },
  slider: {flex: 1, minWidth: 0, flexDirection: 'row'},
  main: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: PAD,
    paddingHorizontal: PAD,
    // Three more at the bottom than the top: the progress line lives down
    // there now, and the artwork needs to clear it.
    paddingBottom: PAD + 3,
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
    overflow: 'hidden',
  },
  artFill: {width: '100%', height: '100%'},
  artFallback: {backgroundColor: C.bg},
  text: {flex: 1, minWidth: 0},
  // 14/600 over 11.5/400-at-62%. The old pair was 13/700 and 12/400 — one pixel
  // apart, which is no hierarchy at all. The contrast gap does more work here
  // than the size gap.
  title: {fontSize: 14, fontWeight: '600', color: C.text, letterSpacing: 0.1},
  artist: {fontSize: 11.5, color: C.text, opacity: 0.62, marginTop: 2},
  output: {
    fontSize: 10.5,
    fontWeight: '600',
    color: C.accent,
    marginTop: 2,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: S.gutter - 8,
  },
  ctl: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The same 42x42 slot as the other two. No disc: `playNudge` went with it,
  // since it existed only to optically centre a triangle inside a circle.
  playBtn: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressTrack: {
    position: 'absolute',
    // Edge to edge along the very bottom. It used to be inset by 12 to keep
    // clear of the rounded corners, which put it level with the bottom edge of
    // the 54px artwork — the two read as one smudged line. `overflow: hidden`
    // on the wrap already clips it to the radius, so the inset was buying
    // nothing and costing the clash.
    left: 0,
    right: 0,
    bottom: 0,
    height: 2.5,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  progressFill: {
    height: '100%',
    // Not pure white: at the very bottom edge of a coloured bar, C.text read as
    // a second, brighter border rather than as progress.
    backgroundColor: 'rgba(255,255,255,0.85)',
  },
});
