/**
 * The "where this plays from" and "what bitrate" pills.
 *
 * Both read their own setting rather than making every call site check first,
 * so a caller can drop them in unconditionally and they simply render nothing
 * when the user hasn't asked for them.
 */
import React from 'react';
import {StyleSheet, Text} from 'react-native';
import {C} from '../theme';
import {useSettings} from '../store';
import {getPlayableSource} from '../tracks';
import type {Track} from '../backend';

/** One palette for "which source" everywhere — the badge on a track row and
 *  the Sources list in Settings must never disagree about a colour. */
export const SOURCE_META: Record<string, {label: string; tint: string}> = {
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
  const meta = source ? SOURCE_META[source] : undefined;
  if (!meta) {
    return null;
  }
  // Just the coloured word — no pill, no tinted rectangle behind it.
  return <Text style={[styles.text, {color: meta.tint}]}>{meta.label}</Text>;
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
  // Number WITH its unit — no pill behind it.
  return <Text style={[styles.text, styles.qualityText]}>{kbps} kbps</Text>;
}

const styles = StyleSheet.create({
  text: {fontSize: 10.5, fontWeight: '700', lineHeight: 13},
  qualityText: {color: C.sub},
});
