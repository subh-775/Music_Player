/**
 * The in-app update prompt. Appears when a newer release is found, shows the
 * download progress in place, and lets the user install or dismiss.
 *
 * A Sheet, not a centred Modal. Everything else in the app that asks a question
 * is a Sheet or a ConfirmModal; a card floating in the middle of a dimmed
 * screen read as something the OS had put in front of the app rather than part
 * of it. It also gets "Later" for free — drag it away.
 */
import React from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {AlertTriangle, ArrowRight, Download} from 'lucide-react-native';
import {C, S} from '../theme';
import {appVersion} from '../backend';
import {dismissUpdate, startUpdateInstall, useUpdate} from '../update';
import {Sheet} from './Sheet';
import {formatSize, readableNotes} from '../updateNotes';

export function UpdateModal() {
  const {phase, info, pct} = useUpdate();
  const visible =
    phase === 'found' || phase === 'downloading' || phase === 'failed';
  const failed = phase === 'failed';
  const notes = readableNotes(info?.notes ?? '');
  const size = formatSize(info?.sizeBytes);

  return (
    <Sheet open={visible} onClose={dismissUpdate} style={styles.sheet}>
      <View style={styles.body}>
        {/* An update is a FILE ARRIVING. The sparkle that used to be here is
            the visual language of a promotional banner, and it was also the
            sidebar's glyph for "Your sound" — one icon meaning two unrelated
            things. AlertTriangle stays for the failure; that one was right. */}
        <View style={[styles.badge, failed && styles.badgeWarn]}>
          {failed ? (
            <AlertTriangle size={22} color={C.danger} strokeWidth={2.2} />
          ) : (
            <Download size={22} color={C.accent} strokeWidth={2.2} />
          )}
        </View>

        {phase === 'downloading' ? (
          <>
            <Text style={styles.title}>Downloading update</Text>
            <Text style={styles.message}>
              Relaxify {info?.version} — this only takes a moment.
            </Text>
            <View style={styles.barTrack}>
              <View style={[styles.barFill, {width: `${Math.max(4, pct)}%`}]} />
            </View>
            <Text style={styles.pct}>{pct}%</Text>
          </>
        ) : failed ? (
          <>
            <Text style={styles.title}>Update failed</Text>
            <Text style={styles.message}>
              Couldn&apos;t download the update. Check your connection and try
              again.
            </Text>
            <View style={styles.actions}>
              <TouchableOpacity
                style={[styles.btn, styles.cancel]}
                onPress={dismissUpdate}>
                <Text style={styles.cancelText}>Later</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, styles.confirm]}
                onPress={startUpdateInstall}>
                <Text style={styles.confirmText}>Retry</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <>
            <Text style={styles.title}>Update available</Text>
            {/* from -> to, not a bare version number — that's what actually
                answers "what changes for me". The size sits on the same line,
                right-aligned: it is the one fact that decides whether someone
                taps Update while on mobile data. */}
            <View style={styles.versionRow}>
              <Text style={styles.versionFrom}>{appVersion || '—'}</Text>
              <ArrowRight size={13} color={C.faint} strokeWidth={2.4} />
              <Text style={styles.versionTo}>{info?.version}</Text>
              {!!size && <Text style={styles.size}>{size}</Text>}
            </View>
            {!!notes && (
              <Text style={styles.message} numberOfLines={6}>
                {notes}
              </Text>
            )}
            <View style={styles.actions}>
              <TouchableOpacity
                style={[styles.btn, styles.cancel]}
                onPress={dismissUpdate}>
                <Text style={styles.cancelText}>Later</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, styles.confirm]}
                onPress={startUpdateInstall}>
                <Text style={styles.confirmText}>Update</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // Scrim, handle, rounded top and the slide all live in <Sheet>.
  sheet: {},
  body: {paddingHorizontal: S.gutter, paddingTop: 6, paddingBottom: 18},
  badge: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(29,185,84,0.14)',
    marginBottom: 14,
  },
  badgeWarn: {backgroundColor: 'rgba(255,107,107,0.14)'},
  title: {color: C.text, fontSize: 18, fontWeight: '800'},
  versionRow: {flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 6},
  versionFrom: {color: C.faint, fontSize: 13, fontWeight: '600'},
  versionTo: {color: C.accent, fontSize: 14, fontWeight: '800'},
  size: {color: C.faint, fontSize: 13, marginLeft: 'auto'},
  message: {color: C.sub, fontSize: 13, lineHeight: 19, marginTop: 10},
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 22,
  },
  btn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    minWidth: 88,
    alignItems: 'center',
  },
  cancel: {backgroundColor: C.surface},
  cancelText: {color: C.text, fontWeight: '700', fontSize: 14},
  confirm: {backgroundColor: C.accent},
  confirmText: {color: C.bg, fontWeight: '800', fontSize: 14},
  barTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.14)',
    marginTop: 16,
    overflow: 'hidden',
  },
  barFill: {height: '100%', borderRadius: 3, backgroundColor: C.accent},
  pct: {color: C.sub, fontSize: 12, marginTop: 8, textAlign: 'right'},
});
