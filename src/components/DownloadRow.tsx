/**
 * A download in flight: dimmed row, live percentage, and a real progress bar.
 *
 * A queued job has no percentage yet, so the bar shows an indeterminate sliver
 * rather than sitting at zero — zero reads as stalled, a sliver reads as
 * starting.
 */
import React from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';
import {C, S, T} from '../theme';
import {cleanText, getBestArtworkUrl} from '../tracks';
import type {DownloadJob} from '../downloads';

export function DownloadRow({job}: {job: DownloadJob}) {
  const artwork = getBestArtworkUrl(job.track);
  const pct = job.progress ?? 0;
  const indeterminate = job.progress === null;
  const failed = job.status === 'error';

  return (
    <View style={styles.row}>
      {artwork ? (
        <Image source={{uri: artwork}} style={styles.art} />
      ) : (
        <View style={[styles.art, styles.artEmpty]} />
      )}

      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {cleanText(job.track.title)}
        </Text>

        <View style={styles.barRow}>
          <View style={styles.track}>
            <View
              style={[
                styles.fill,
                failed && styles.fillFailed,
                {width: indeterminate ? '8%' : `${Math.round(pct * 100)}%`},
              ]}
            />
          </View>
          <Text style={styles.pct}>
            {failed
              ? 'Failed'
              : indeterminate
              ? 'Queued'
              : `${Math.round(pct * 100)}%`}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: S.gutter,
    paddingVertical: 8,
    opacity: 0.75,
  },
  art: {width: 46, height: 46, borderRadius: 5, backgroundColor: C.surface},
  artEmpty: {backgroundColor: C.surfaceHi},
  text: {flex: 1, minWidth: 0},
  title: {...T.body, color: C.text},
  barRow: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6},
  track: {
    flex: 1,
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.14)',
    overflow: 'hidden',
  },
  fill: {height: '100%', borderRadius: 2, backgroundColor: C.accent},
  fillFailed: {backgroundColor: C.danger},
  pct: {
    ...T.sub,
    color: C.sub,
    fontSize: 11,
    minWidth: 46,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
});
