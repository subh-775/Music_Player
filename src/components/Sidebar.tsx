/**
 * The navigation drawer.
 *
 * Opens from the hamburger on Home, or by dragging in from anywhere in Home's
 * empty space. It holds the things that are *about* the app rather than about
 * the music — settings, shortcuts, your listening activity — so the bottom nav
 * stays purely about content and the Home header loses its stray gear.
 *
 * Driven by ONE Animated.Value, `drawerX`, which lives in ../drawer rather than
 * in this component. That is what lets the opening gesture drive the panel
 * directly: the finger writes to the same value the settle animation does, so
 * the panel tracks the drag from the first pixel instead of appearing after the
 * finger lifts. The scrim's opacity is an interpolation of that same value, so
 * the dim and the slide can never disagree mid-gesture.
 *
 * NOT a <Modal>, for the same reason nothing else in this app is: a Modal is its
 * own window, it cannot be dragged into view underneath an in-progress gesture,
 * and it floats over the mini player. As a plain absolute overlay it can be
 * half-open, which is the whole feature.
 */
import React, {useCallback, useEffect, useMemo, useRef} from 'react';
import {
  BackHandler,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {Gesture, GestureDetector} from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
} from 'react-native-reanimated';
import {
  ArrowUpRight,
  AudioLines,
  BookOpen,
  ChevronRight,
  Clock,
  Settings as SettingsIcon,
  SlidersHorizontal,
} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {appVersion} from '../backend';
import {useUpdateAvailable} from '../update';
import {DRAWER_W, drawerX, settleDrawer} from '../drawer';

const ICON = require('../assets/app-icon.png');

export type SidebarDest = 'settings' | 'help' | 'stats' | 'equalizer';

// No per-item hint text any more — "Everything you have listened to" under
// "Recents" was explaining a label that already explains itself, and it made
// every row two lines for no reason. The label is enough.
//
// Sleep timer and Equalizer are both things you reach for WHILE listening, and
// both were buried inside Settings — the wrong depth for something you want
// with the phone already face-down.
//
// Queue is gone from here: the player's own queue handle is a better home for
// it, one swipe from where you already are. Recents is gone too — it was the
// same history "Your sound" already presents, sorted differently, and one
// listening page is enough.
//
// Shortcuts is gone as well, and so is the screen behind it. It was a list of
// gestures maintained by hand inside the app, which meant it went stale every
// time a gesture changed and it could only ever describe the version you had
// already installed. Help opens the documentation instead — the same content,
// kept next to the code that implements it, and reachable before you install
// anything. That is also why "About" left Settings: one door, not two.
// Sleep timer is NOT here any more. It is a now-action taken with the phone
// already face-down, and the drawer is two gestures away from the music; it
// lives beside the queue in the player, where the thing it acts on is.
const ITEMS: {id: SidebarDest; label: string; Icon: typeof Clock}[] = [
  {id: 'equalizer', label: 'Equalizer', Icon: SlidersHorizontal},
  // AudioLines, not Sparkles: a sparkle says "AI" to most people now, and it
  // is also the badge on the update popup — the same glyph meaning two
  // unrelated things. A waveform reads as "your listening" with no caption.
  {id: 'stats', label: 'Your sound', Icon: AudioLines},
  {id: 'help', label: 'Read docs', Icon: BookOpen},
  {id: 'settings', label: 'Settings', Icon: SettingsIcon},
];

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
export const Sidebar = React.memo(function Sidebar({
  visible,
  onClose,
  onNavigate,
}: {
  /** Mounted and interactive. Turns TRUE the moment a drag begins, not when it
   *  finishes — the panel is on screen and moving while the finger is down. */
  visible: boolean;
  onClose: () => void;
  onNavigate: (dest: SidebarDest) => void;
}) {
  const updateWaiting = useUpdateAvailable();

  // onClose is an inline arrow from the app, so it has a new identity on every
  // app render. Held in a ref, it can be called from a gesture without its
  // identity becoming an input to any effect — which is what used to re-run the
  // open effect mid-navigation and slam the panel back open.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const close = useCallback((velocity = 0) => {
    settleDrawer(false, velocity, finished => {
      if (finished) {
        closeRef.current();
      }
    });
  }, []);

  // Hardware back closes the drawer before anything else sees it.
  useEffect(() => {
    if (!visible) {
      return;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [visible, close]);

  /**
   * Drag LEFT on the open panel to push it back out — the mirror of the gesture
   * that opened it, on the same shared value.
   *
   * Native recognition, like the pull: activeOffsetX/failOffsetY instead of a
   * JS ratio test, so a quick flick closes it as reliably as a slow drag.
   */
  const settleFromGesture = useCallback(
    (open: boolean, velocity: number) => {
      if (open) {
        settleDrawer(true, velocity);
      } else {
        close(velocity);
      }
    },
    [close],
  );

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-15, 1000])
        .failOffsetY([-16, 16])
        .onUpdate(e => {
          drawerX.value = Math.max(-DRAWER_W, Math.min(0, e.translationX));
        })
        .onEnd(e => {
          const stayOpen = !(
            e.translationX < -DRAWER_W / 3 || e.velocityX < -500
          );
          runOnJS(settleFromGesture)(stayOpen, Math.abs(e.velocityX) / 1000);
        }),
    [settleFromGesture],
  );

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{translateX: drawerX.value}],
  }));
  // One value drives both, so the dim and the slide can never disagree.
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(drawerX.value, [-DRAWER_W, 0], [0, 1], 'clamp'),
  }));

  const go = useCallback(
    (dest: SidebarDest) => {
      // Navigate first, then slide away — the destination is already mounted
      // behind the drawer, so this reads as the drawer uncovering it.
      onNavigate(dest);
      close();
    },
    [onNavigate, close],
  );

  /**
   * Rendered ALWAYS, never conditionally mounted.
   *
   * It used to mount when the drag began — which meant React reconciliation
   * plus native view creation for the panel, the scrim, four rows and their
   * icons all landed on the JS thread in exactly the frames that should have
   * been moving the panel. On a fast pull you lost every one of them. Parked
   * off-screen at -DRAWER_W it costs nothing to leave in the tree, and the
   * first frame of a drag now moves something that already exists.
   *
   * `pointerEvents` is what keeps a closed drawer from eating touches.
   */
  return (
    <View style={styles.host} pointerEvents={visible ? 'box-none' : 'none'}>
      <Animated.View style={[styles.scrim, scrimStyle]}>
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          activeOpacity={1}
          onPress={() => close()}
        />
      </Animated.View>

      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.panel, panelStyle]}>
          {/* The app's own mark, not just a word. A bare text line read as a
            stray label; the icon is what makes the drawer feel like part of
            the product. */}
          <View style={styles.brandRow}>
            <Image source={ICON} style={styles.brandIcon} />
            <View style={styles.brandText}>
              <Text style={styles.brand}>Relaxify</Text>
              <Text style={styles.brandSub}>Your library, your sound</Text>
            </View>
          </View>

          <View style={styles.items}>
            {ITEMS.map(item => (
              <TouchableOpacity
                key={item.id}
                style={styles.item}
                activeOpacity={0.7}
                onPress={() => go(item.id)}>
                <item.Icon size={21} color={C.text} strokeWidth={2} />
                <View style={styles.itemText}>
                  <Text style={styles.itemLabel}>{item.label}</Text>
                </View>
                {/* The update lives inside Settings, so the dot follows it here —
                  the one on the hamburger only says "look inside". */}
                {item.id === 'settings' && updateWaiting && (
                  <View style={styles.dot} />
                )}
                {/* Help leaves the app for the documentation site, and a
                    chevron promises the opposite — another page in here. */}
                {item.id === 'help' ? (
                  <ArrowUpRight size={17} color={C.faint} />
                ) : (
                  <ChevronRight size={17} color={C.faint} />
                )}
              </TouchableOpacity>
            ))}
          </View>

          {/* Version, centred, and nothing else — as specified. */}
          <Text style={styles.version}>v{appVersion || '—'}</Text>
        </Animated.View>
      </GestureDetector>
    </View>
  );
});

const styles = StyleSheet.create({
  // Covers the whole app, above everything, but box-none so only the scrim and
  // the panel themselves take touches.
  host: {...StyleSheet.absoluteFillObject, zIndex: 45},
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: DRAWER_W,
    // Nearly black, barely translucent. The lighter grey it used to be
    // (rgba(20,20,20,0.93)) floated as a visibly separate grey slab over an
    // AMOLED-black app; sitting this close to the background makes the panel
    // read as the app itself sliding aside, and the labels gain contrast rather
    // than lose it. The hairline edge is what still separates it from the page.
    backgroundColor: 'rgba(8,8,8,0.97)',
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: 'rgba(255,255,255,0.10)',
    paddingTop: 52,
    borderTopRightRadius: 18,
    borderBottomRightRadius: 18,
  },
  // Bigger than a nav row's own icon+label — this is the one place the app
  // introduces itself, so it earns more weight than the items under it.
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: S.gutter,
    marginBottom: 28,
  },
  brandIcon: {width: 56, height: 56, borderRadius: 14},
  brandText: {flex: 1, minWidth: 0},
  brand: {...T.screenTitle, color: C.text, fontSize: 24, letterSpacing: 0.1},
  brandSub: {color: C.sub, fontSize: 12.5, marginTop: 2},
  items: {flex: 1},
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 15,
    paddingHorizontal: S.gutter,
    paddingVertical: 14,
  },
  itemText: {flex: 1, minWidth: 0},
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: C.accent,
    marginRight: 4,
  },
  itemLabel: {color: C.text, fontSize: 15.5, fontWeight: '700'},
  itemValue: {color: C.accent, fontSize: 12.5, fontWeight: '700'},
  version: {
    color: C.faint,
    fontSize: 12,
    textAlign: 'center',
    paddingBottom: 22,
    letterSpacing: 0.4,
  },
});
