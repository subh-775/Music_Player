/**
 * The in-app update popup. Appears when a newer release is found, shows the
 * download progress in place, and lets the user install or dismiss. Styled like
 * the rest of the app (matches ConfirmModal), not the OS.
 */
import React from 'react';
import {Modal, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {AlertTriangle, ArrowRight, Sparkles} from 'lucide-react-native';
import {C} from '../theme';
import {appVersion} from '../backend';
import {
  dismissUpdate,
  startUpdateInstall,
  useUpdate,
} from '../update';

export function UpdateModal() {
  const {phase, info, pct} = useUpdate();
  const visible = phase === 'found' || phase === 'downloading' || phase === 'failed';
  const failed = phase === 'failed';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={dismissUpdate}
      statusBarTranslucent>
      <View style={styles.scrim}>
        <View style={styles.card}>
          {/* One badge, coloured by outcome — an accent burst for good news, a
              flat amber ring for a failure. Replaces the plain text heading,
              which read as a system dialog rather than part of the app. */}
          <View style={[styles.badge, failed && styles.badgeWarn]}>
            {failed ? (
              <AlertTriangle size={22} color={C.danger} strokeWidth={2.2} />
            ) : (
              <Sparkles size={22} color={C.accent} strokeWidth={2.2} />
            )}
          </View>

          {phase === 'downloading' ? (
            <>
              <Text style={styles.title}>Downloading update</Text>
              <Text style={styles.message}>
                Fix_Music {info?.version} — hang tight, this only takes a moment.
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
                  answers "what changes for me". */}
              <View style={styles.versionRow}>
                <Text style={styles.versionFrom}>{appVersion || '—'}</Text>
                <ArrowRight size={13} color={C.faint} strokeWidth={2.4} />
                <Text style={styles.versionTo}>{info?.version}</Text>
              </View>
              {!!info?.notes && (
                <Text style={styles.message} numberOfLines={6}>
                  {info.notes.trim()}
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
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 36,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: C.surfaceHi,
    borderRadius: 18,
    padding: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
  },
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
  message: {color: C.sub, fontSize: 13, lineHeight: 19, marginTop: 10},
  actions: {flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 22},
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
