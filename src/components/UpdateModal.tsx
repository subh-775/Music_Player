/**
 * The in-app update prompt: a card floating above the mini player. Appears when
 * a newer release is found, shows the download progress in place, and lets
 * the user install or put it off.
 *
 * A card, not a sheet or a dialog: the page stays visible and usable around
 * it, so a new version is news rather than an interruption.
 *
 * A failure shows here only when a DOWNLOAD failed (see `attempted` in
 * update.ts). A failed automatic check stays quiet; Settings reports it.
 *
 * The same spot carries the one-time usage-statistics notice, after any update
 * card, so the two never stack.
 */
import React from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import Animated, {FadeInDown, FadeOutDown} from 'react-native-reanimated';
import {AlertTriangle, ChartColumn, RefreshCw, X} from '../icons';
import {C, S} from '../theme';
import {dismissUpdate, startUpdateInstall, useUpdate} from '../update';
import {formatSize, readableNotes} from '../updateNotes';
import {BOTTOM_INSET} from '../layout';
import {createStore, useStoreValue} from '../storage';
import {ANALYTICS_NOTE} from '../analytics';

const noticeSeen = createStore<boolean>(
  'mp.analyticsNoticeSeen.v1',
  false,
  raw => raw === true,
);

const FALLBACK =
  'This update contains several bug fixes and performance improvements.';

export function UpdateModal() {
  const {phase, info, pct, error, attempted} = useUpdate();
  const seen = useStoreValue(noticeSeen);
  const failed = phase === 'failed' && attempted;
  if (phase !== 'found' && phase !== 'downloading' && !failed) {
    return seen ? null : <Notice />;
  }
  const downloading = phase === 'downloading';
  const size = formatSize(info?.sizeBytes);

  const title = failed
    ? 'Update failed'
    : downloading
    ? `Downloading ${info?.version ?? 'update'}`
    : `Version ${info?.version} is now available!`;
  const message = failed
    ? error && error !== 'Download failed'
      ? error
      : "Couldn't download the update. Check your connection and try again."
    : readableNotes(info?.notes ?? '') || FALLBACK;

  return (
    <Animated.View
      entering={FadeInDown.duration(260)}
      exiting={FadeOutDown.duration(180)}
      style={styles.card}
      accessibilityLiveRegion="polite">
      <View style={styles.row}>
        <View style={[styles.badge, failed && styles.badgeWarn]}>
          {failed ? (
            <AlertTriangle size={18} color={C.danger} strokeWidth={2.2} />
          ) : (
            <RefreshCw size={18} color={C.accent} strokeWidth={2.2} />
          )}
        </View>
        <View style={styles.text}>
          <Text style={styles.title}>{title}</Text>
          {downloading ? (
            <>
              <View style={styles.barTrack}>
                <View
                  style={[styles.barFill, {width: `${Math.max(4, pct)}%`}]}
                />
              </View>
              <Text style={styles.meta}>
                {pct}%{size ? ` of ${size}` : ''}
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.message} numberOfLines={3}>
                {message}
              </Text>
              <View style={styles.actions}>
                <TouchableOpacity
                  style={styles.install}
                  onPress={startUpdateInstall}
                  accessibilityRole="button">
                  <Text style={styles.installText}>
                    {failed ? 'Retry' : 'Install'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.later}
                  onPress={dismissUpdate}
                  accessibilityRole="button">
                  <Text style={styles.laterText}>Later</Text>
                </TouchableOpacity>
                {!failed && !!size && <Text style={styles.size}>{size}</Text>}
              </View>
            </>
          )}
        </View>
        {!downloading && (
          <TouchableOpacity
            onPress={dismissUpdate}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close">
            <X size={18} color={C.sub} strokeWidth={2.2} />
          </TouchableOpacity>
        )}
      </View>
    </Animated.View>
  );
}

function Notice() {
  const close = () => noticeSeen.set(true);
  return (
    <Animated.View
      entering={FadeInDown.duration(260)}
      exiting={FadeOutDown.duration(180)}
      style={styles.card}>
      <View style={styles.row}>
        <View style={styles.badge}>
          <ChartColumn size={18} color={C.accent} strokeWidth={2.2} />
        </View>
        <View style={styles.text}>
          <Text style={styles.title}>Usage statistics</Text>
          <Text style={styles.message}>{ANALYTICS_NOTE}</Text>
          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.install}
              onPress={close}
              accessibilityRole="button">
              <Text style={styles.installText}>Got it</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    left: S.gutter,
    right: S.gutter,
    bottom: BOTTOM_INSET + 8,
    padding: 16,
    borderRadius: 14,
    backgroundColor: C.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.14)',
    elevation: 12,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: {width: 0, height: 6},
  },
  row: {flexDirection: 'row', alignItems: 'flex-start', gap: 12},
  badge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(29,185,84,0.35)',
    backgroundColor: 'rgba(29,185,84,0.10)',
  },
  badgeWarn: {
    borderColor: 'rgba(255,107,107,0.35)',
    backgroundColor: 'rgba(255,107,107,0.10)',
  },
  text: {flex: 1, minWidth: 0},
  title: {color: C.text, fontSize: 15, fontWeight: '800'},
  message: {color: C.sub, fontSize: 13, lineHeight: 19, marginTop: 4},
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 14,
  },
  install: {
    backgroundColor: C.accent,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  installText: {color: C.bg, fontWeight: '800', fontSize: 14},
  later: {paddingHorizontal: 14, paddingVertical: 9},
  laterText: {color: C.text, fontWeight: '700', fontSize: 14},
  size: {color: C.faint, fontSize: 12, marginLeft: 'auto'},
  barTrack: {
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.14)',
    marginTop: 12,
    overflow: 'hidden',
  },
  barFill: {height: '100%', borderRadius: 3, backgroundColor: C.accent},
  meta: {color: C.sub, fontSize: 12, marginTop: 6},
});
