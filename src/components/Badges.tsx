/**
 * The "where this plays from" and "what bitrate" pills.
 *
 * Both read their own setting rather than making every call site check first,
 * so a caller can drop them in unconditionally and they simply render nothing
 * when the user hasn't asked for them.
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {C} from '../theme';
import {useSettings} from '../store';
import {getPlayableSource} from '../tracks';
import type {Track} from '../backend';

const META: Record<string, {label: string; tint: string}> = {
  jiosaavn: {label: 'JioSaavn', tint: '#1ed760'},
  soundcloud: {label: 'SoundCloud', tint: '#ff7733'},
  youtube: {label: 'YouTube', tint: '#ff4444'},
  youtube_music: {label: 'YT Music', tint: '#ff4444'},
  local: {label: 'Offline', tint: '#8b7bd8'},
};

export function SourceBadge({track}: {track: Track | null}) {
  const {showSourceBadge} = useSettings();
  if (!showSourceBadge || !track) {
    return null;
  }
  const source =
    track.playable_source || track.primary_source || getPlayableSource(track);
  const meta = source ? META[source] : undefined;
  if (!meta) {
    return null;
  }
  return (
    <View style={[styles.pill, {backgroundColor: `${meta.tint}26`}]}>
      <Text style={[styles.text, {color: meta.tint}]}>{meta.label}</Text>
    </View>
  );
}

/**
 * Live bitrate. Prefers what the backend reports is ACTUALLY streaming, then
 * the source's own metadata, then the quality setting — in that order, because
 * the setting is a ceiling, not a promise.
 */
export function QualityBadge({
  track,
  kbps: measured = 0,
}: {
  track: Track | null;
  kbps?: number;
}) {
  const {showQualityBadge, audioQuality} = useSettings();
  if (!showQualityBadge || !track) {
    return null;
  }
  const source =
    track.playable_source || track.primary_source || getPlayableSource(track);
  const reported = Number(source ? track.sources?.[source]?.bitrate : 0) || 0;
  const kbps =
    measured > 0
      ? measured
      : reported > 0
      ? reported
      : audioQuality > 0
      ? audioQuality
      : 320;
  if (!kbps) {
    return null;
  }
  return (
    <View style={[styles.pill, styles.quality]}>
      <Text style={[styles.text, styles.qualityText]}>{kbps} kbps</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2.5,
  },
  quality: {backgroundColor: 'rgba(255,255,255,0.10)'},
  text: {fontSize: 10, fontWeight: '700', lineHeight: 12},
  qualityText: {color: C.sub},
});
