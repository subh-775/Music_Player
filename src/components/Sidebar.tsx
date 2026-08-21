/**
 * The navigation drawer.
 *
 * Opens from the hamburger on Home, or by dragging in from the left edge. It
 * holds the things that are *about* the app rather than about the music —
 * settings, shortcuts, your listening activity — so the bottom nav stays purely
 * about content and the Home header loses its stray gear.
 *
 * Driven by one Animated.Value: the panel's X offset. The scrim's opacity is an
 * interpolation of the same value, so the dim and the slide can never disagree
 * mid-gesture (they did when they were separate animations).
 */
import React, {useCallback, useEffect, useRef} from 'react';
import {
  Animated,
  BackHandler,
  Dimensions,
  Easing,
  Image,
  Modal,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  ChevronRight,
  Clock,
  Keyboard,
  Settings as SettingsIcon,
  Sparkles,
} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {appVersion} from '../backend';
import {useUpdateAvailable} from '../update';

const ICON = require('../assets/app-icon.png');

const W = Math.min(320, Dimensions.get('window').width * 0.82);

export type SidebarDest = 'recents' | 'settings' | 'shortcuts' | 'stats';

// No per-item hint text any more — "Everything you have listened to" under
// "Recents" was explaining a label that already explains itself, and it made
// every row two lines for no reason. The label is enough.
const ITEMS: {id: SidebarDest; label: string; Icon: typeof Clock}[] = [
  {id: 'recents', label: 'Recents', Icon: Clock},
  {id: 'stats', label: 'Your sound', Icon: Sparkles},
  {id: 'shortcuts', label: 'Shortcuts', Icon: Keyboard},
  {id: 'settings', label: 'Settings', Icon: SettingsIcon},
];

export function Sidebar({
  visible,
  onClose,
  onNavigate,
}: {
  visible: boolean;
  onClose: () => void;
  onNavigate: (dest: SidebarDest) => void;
}) {
  // -W = fully off-screen left, 0 = fully open.
  const x = useRef(new Animated.Value(-W)).current;
  const updateWaiting = useUpdateAvailable();

  const settle = useCallback(
    (open: boolean, velocity = 0) => {
      Animated.timing(x, {
        toValue: open ? 0 : -W,
        duration: velocity > 1.2 ? 140 : 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(({finished}) => {
        if (finished && !open) {
          onClose();
        }
      });
    },
    [x, onClose],
  );

  /**
   * Open when `visible` turns on — and ONLY then.
   *
   * This used to depend on `settle`, which depends on `onClose`, which the app
   * passes as an inline arrow. So every re-render of the app produced a new
   * `onClose`, a new `settle`, and re-ran this effect — and because `visible`
   * was still true at that moment, it slammed the panel back open. Tapping a
   * drawer item navigates (a re-render), so the drawer re-opened on top of the
   * page it had just opened; tapping again from there stacked a second screen.
   *
   * `settle` in a ref keeps the animation callable without making identity
   * changes an input to "should the drawer open".
   */
  const settleRef = useRef(settle);
  settleRef.current = settle;

  useEffect(() => {
    if (visible) {
      x.setValue(-W);
      settleRef.current(true);
    }
  }, [visible, x]);

  // Hardware back closes the drawer before anything else sees it.
  useEffect(() => {
    if (!visible) {
      return;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      settle(false);
      return true;
    });
    return () => sub.remove();
  }, [visible, settle]);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) =>
        g.dx < -8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderMove: (_e, g) => {
        if (g.dx < 0) {
          x.setValue(Math.max(-W, g.dx));
        }
      },
      onPanResponderRelease: (_e, g) => {
        settle(!(g.dx < -W / 3 || g.vx < -0.5), Math.abs(g.vx));
      },
      onPanResponderTerminate: () => settle(true),
    }),
  ).current;

  const go = useCallback(
    (dest: SidebarDest) => {
      // Navigate first, then slide away — the destination is already mounted
      // behind the drawer, so this reads as the drawer uncovering it.
      onNavigate(dest);
      settle(false);
    },
    [onNavigate, settle],
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={() => settle(false)}
      statusBarTranslucent>
      <Animated.View
        style={[
          styles.scrim,
          {
            opacity: x.interpolate({
              inputRange: [-W, 0],
              outputRange: [0, 1],
              extrapolate: 'clamp',
            }),
          },
        ]}>
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          activeOpacity={1}
          onPress={() => settle(false)}
        />
      </Animated.View>

      <Animated.View
        style={[styles.panel, {transform: [{translateX: x}]}]}
        {...pan.panHandlers}>
        {/* The app's own mark, not just a word. A bare text line read as a
            stray label; the icon is what makes the drawer feel like part of
            the product. */}
        <View style={styles.brandRow}>
          <Image source={ICON} style={styles.brandIcon} />
          <View style={styles.brandText}>
            <Text style={styles.brand}>Fix_Music</Text>
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
              <ChevronRight size={17} color={C.faint} />
            </TouchableOpacity>
          ))}
        </View>

        {/* Version, centred, and nothing else — as specified. */}
        <Text style={styles.version}>v{appVersion || '—'}</Text>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: W,
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
  version: {
    color: C.faint,
    fontSize: 12,
    textAlign: 'center',
    paddingBottom: 22,
    letterSpacing: 0.4,
  },
});
