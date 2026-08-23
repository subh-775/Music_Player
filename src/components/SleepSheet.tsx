/**
 * The sleep timer, one tap from the drawer.
 *
 * It already existed in Settings, buried under Listening controls — which is
 * the wrong place for it: it is a NOW action, taken in the dark, usually with
 * the phone already face-down. Setting it should not mean opening Settings,
 * scrolling past playback quality and finding a row of chips.
 *
 * Settings keeps its copy (that is where you go looking for a setting), and
 * both drive the same module, so the two can never disagree about what is
 * armed.
 */
import React from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {Check, Moon} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {
  cancelSleepTimer,
  sleepAtEndOfTrack,
  sleepLabel,
  startSleepTimer,
  useSleepTimer,
} from '../sleepTimer';
import {Sheet} from './Sheet';

const MINUTES = [15, 30, 45, 60];

export function SleepSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const sleep = useSleepTimer();
  const label = sleepLabel(sleep);

  const pick = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose}>
      <View style={styles.head}>
        <Moon size={19} color={C.accent} />
        <View style={styles.headText}>
          <Text style={styles.title}>Sleep timer</Text>
          <Text style={styles.sub}>
            {label ? `Music stops in ${label}` : 'Music keeps playing'}
          </Text>
        </View>
      </View>

      {MINUTES.map(m => {
        // Armed to roughly this length, so the current choice reads back. A
        // running timer never matches its start value exactly, hence the
        // window rather than an equality test.
        const on =
          sleep.mode === 'clock' &&
          Math.abs(sleep.remaining - m * 60) < 60 &&
          sleep.remaining <= m * 60;
        return (
          <TouchableOpacity
            key={m}
            style={styles.row}
            activeOpacity={0.7}
            onPress={pick(() => startSleepTimer(m))}>
            <Text style={styles.rowLabel}>{m} minutes</Text>
            {on && <Check size={18} color={C.accent} />}
          </TouchableOpacity>
        );
      })}

      <TouchableOpacity
        style={styles.row}
        activeOpacity={0.7}
        onPress={pick(sleepAtEndOfTrack)}>
        <Text style={styles.rowLabel}>End of this track</Text>
        {sleep.mode === 'endOfTrack' && <Check size={18} color={C.accent} />}
      </TouchableOpacity>

      {sleep.mode !== 'off' && (
        <TouchableOpacity
          style={styles.row}
          activeOpacity={0.7}
          onPress={pick(cancelSleepTimer)}>
          <Text style={[styles.rowLabel, styles.off]}>Turn off</Text>
        </TouchableOpacity>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: S.gutter,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  headText: {flex: 1, minWidth: 0},
  title: {...T.body, color: C.text},
  sub: {...T.sub, color: C.sub, marginTop: 2},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: S.gutter,
    paddingVertical: 14,
  },
  rowLabel: {fontSize: 15, color: C.text},
  off: {color: C.sub},
});
