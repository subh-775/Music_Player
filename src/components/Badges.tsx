/**
 * The "where this plays from" and "what bitrate" pills.
 *
 * Both read their own setting rather than making every call site check first,
 * so a caller can drop them in unconditionally and they simply render nothing
 * when the user hasn't asked for them.
 */
import React, {useEffect, useState} from 'react';
import {StyleSheet, Text} from 'react-native';
import {C} from '../theme';
import {currentQuality, useSettings} from '../store';
import {getPlayableSource} from '../tracks';
import {getStreamInfo, type Track} from '../backend';

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
 * Live bitrate — what the source says the stream it handed over carries.
 *
 * It used to fall back to the quality SETTING and then to a flat 320, and the
 * setting is a ceiling, not a fact: on Auto every song from every source read
 * "320 kbps", including YouTube streams that are ~130 and SoundCloud's 128.
 * Now it is the backend's answer (stream_info, cached — the proxy resolved the
 * same URL a moment earlier), then the track's own metadata for a downloaded
 * file, and otherwise nothing at all rather than a number that only looks
 * measured.
 */
export function QualityBadge({track}: {track: Track | null}) {
  const {showQualityBadge, audioQuality} = useSettings();
  const source = track
    ? track.playable_source || track.primary_source || getPlayableSource(track)
    : '';
  const url = source ? track?.sources?.[source]?.url ?? '' : '';
  const [served, setServed] = useState<{key: string; kbps: number}>();
  const key = `${source}|${url}|${audioQuality}`;

  useEffect(() => {
    if (!showQualityBadge || !track || !url || source === 'local') {
      return;
    }
    let live = true;
    getStreamInfo(track, currentQuality())
      .then(info => {
        if (live) {
          setServed({key, kbps: Number(info.bitrate_kbps) || 0});
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // `key` covers the track's identity; the object itself changes identity on
    // every engine event without being a different song.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, showQualityBadge]);

  if (!showQualityBadge || !track) {
    return null;
  }
  let reported = Number(source ? track.sources?.[source]?.bitrate : 0) || 0;
  if (reported > 5000) {
    reported = Math.round(reported / 1000); // some metadata is in bits/s
  }
  const kbps = (served?.key === key && served.kbps) || reported;
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
