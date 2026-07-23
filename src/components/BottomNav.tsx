/**
 * Primary navigation — three thumb-reachable destinations with a label under
 * each icon (Spotify's own pattern; a bare icon makes "Library" ambiguous).
 *
 * Active state is a BOLDER stroke plus a brighter label, not a filled glyph —
 * a solid blob reads as a different icon rather than the same one selected.
 */
import React from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {Home, Search, Library} from 'lucide-react-native';
import {C} from '../theme';

export type Tab = 'home' | 'search' | 'library';

const TABS: {id: Tab; label: string; Icon: typeof Home}[] = [
  {id: 'home', label: 'Home', Icon: Home},
  {id: 'search', label: 'Search', Icon: Search},
  {id: 'library', label: 'Your Library', Icon: Library},
];

export function BottomNav({
  active,
  onChange,
}: {
  active: Tab;
  onChange: (t: Tab) => void;
}) {
  return (
    <View style={styles.bar}>
      {TABS.map(({id, label, Icon}) => {
        const on = active === id;
        return (
          <TouchableOpacity
            key={id}
            style={styles.tab}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityState={{selected: on}}
            onPress={() => onChange(id)}>
            <Icon
              size={23}
              strokeWidth={on ? 2.6 : 1.8}
              color={on ? C.text : C.faint}
            />
            <Text style={[styles.label, on && styles.labelOn]}>{label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: C.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
    paddingBottom: 4,
  },
  tab: {flex: 1, alignItems: 'center', gap: 4, paddingVertical: 9},
  label: {
    fontSize: 10,
    letterSpacing: 0.3,
    fontWeight: '500',
    color: C.faint,
  },
  labelOn: {color: C.text, fontWeight: '700'},
});
