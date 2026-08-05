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

const W = Math.min(320, Dimensions.get('window').width * 0.82);

export type SidebarDest = 'recents' | 'settings' | 'shortcuts' | 'stats';

const ITEMS: {
  id: SidebarDest;
  label: string;
  hint: string;
  Icon: typeof Clock;
}[] = [
  {
    id: 'recents',
    label: 'Recents',
    hint: 'Everything you have listened to',
    Icon: Clock,
  },
  {
    id: 'stats',
    label: 'Your sound',
    hint: 'Top artists and songs you play',
    Icon: Sparkles,
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    hint: 'Every gesture the app knows',
    Icon: Keyboard,
  },
  {
    id: 'settings',
    label: 'Settings',
    hint: 'Playback, sources, storage',
    Icon: SettingsIcon,
  },
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

  useEffect(() => {
    if (visible) {
      x.setValue(-W);
      settle(true);
    }
  }, [visible, x, settle]);

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
        <Text style={styles.brand}>Music Player</Text>

        <View style={styles.items}>
          {ITEMS.map(item => (
            <TouchableOpacity
              key={item.id}
              style={styles.item}
              activeOpacity={0.7}
              onPress={() => go(item.id)}>
              <item.Icon size={21} color={C.text} strokeWidth={2} />
              <View style={styles.itemText}>
                <View style={styles.itemHead}>
                  <Text style={styles.itemLabel}>{item.label}</Text>
                  {/* The update lives inside Settings, so the dot follows it
                      here — the one on the hamburger only says "look inside". */}
                  {item.id === 'settings' && updateWaiting && (
                    <View style={styles.dot} />
                  )}
                </View>
                <Text style={styles.itemHint} numberOfLines={1}>
                  {item.hint}
                </Text>
              </View>
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
  scrim: {...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)'},
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: W,
    backgroundColor: C.surface,
    paddingTop: 52,
    borderTopRightRadius: 18,
    borderBottomRightRadius: 18,
  },
  brand: {
    ...T.screenTitle,
    color: C.text,
    fontSize: 20,
    paddingHorizontal: S.gutter,
    marginBottom: 18,
  },
  items: {flex: 1},
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 15,
    paddingHorizontal: S.gutter,
    paddingVertical: 14,
  },
  itemText: {flex: 1, minWidth: 0},
  itemHead: {flexDirection: 'row', alignItems: 'center', gap: 7},
  dot: {width: 8, height: 8, borderRadius: 4, backgroundColor: C.accent},
  itemLabel: {color: C.text, fontSize: 15.5, fontWeight: '700'},
  itemHint: {color: C.sub, fontSize: 12, marginTop: 2},
  version: {
    color: C.faint,
    fontSize: 12,
    textAlign: 'center',
    paddingBottom: 22,
    letterSpacing: 0.4,
  },
});
