/**
 * One track line. Shared by Search, Library, albums and playlists so a track
 * looks and behaves the same everywhere in the app.
 */
import React, {useCallback, useState} from 'react';
import {Image, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {ArrowDownToLine, Check, Heart, MoreVertical} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {formatDuration, startDownload, type Track} from '../backend';
import {cleanText, getBestArtworkUrl} from '../tracks';
import {useLike} from '../store';
import {toast} from '../toast';
import {SourceBadge} from './Badges';

export function TrackRow({
  track,
  onPress,
  onLongPress,
  onMenu,
  index,
  active,
  /** Show the inline heart and download buttons. On by default; the queue and
   *  other tight lists turn them off to keep the row from getting crowded. */
  showActions = true,
}: {
  track: Track;
  onPress: () => void;
  onLongPress?: () => void;
  onMenu?: () => void;
  index?: number;
  /** True for the track that's currently playing. */
  active?: boolean;
  showActions?: boolean;
}) {
  const dur = formatDuration(track.duration_ms);
  const artwork = getBestArtworkUrl(track);
  const {liked, toggle} = useLike(track);
  const [downloading, setDownloading] = useState(false);
  const downloaded = !!track.file_path;

  const download = useCallback(async () => {
    if (downloading || downloaded) {
      return;
    }
    setDownloading(true);
    try {
      await startDownload(track);
      toast(`Downloading "${cleanText(track.title)}"`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not start that download');
      setDownloading(false);
    }
  }, [track, downloading, downloaded]);

  return (
    <TouchableOpacity
      style={styles.row}
      activeOpacity={0.65}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}>
      {index != null ? (
        <Text style={styles.index}>{index + 1}</Text>
      ) : artwork ? (
        <Image source={{uri: artwork}} style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, styles.thumbFallback]} />
      )}

      <View style={styles.text}>
        <Text
          style={[styles.title, active && styles.titleActive]}
          numberOfLines={1}>
          {cleanText(track.title)}
        </Text>
        <View style={styles.metaLine}>
          <SourceBadge track={track} />
          <Text style={styles.sub} numberOfLines={1}>
            {cleanText(track.artist)}
            {dur ? `  ·  ${dur}` : ''}
          </Text>
        </View>
      </View>

      {showActions && (
        <>
          <TouchableOpacity onPress={toggle} hitSlop={6} style={styles.act}>
            <Heart
              size={18}
              color={liked ? C.accent : C.faint}
              fill={liked ? C.accent : 'transparent'}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={download}
            hitSlop={6}
            style={styles.act}
            disabled={downloaded || downloading}>
            {downloaded || downloading ? (
              <Check size={18} color={C.accent} />
            ) : (
              <ArrowDownToLine size={18} color={C.faint} />
            )}
          </TouchableOpacity>
        </>
      )}

      {!!onMenu && (
        <TouchableOpacity onPress={onMenu} hitSlop={8} style={styles.menu}>
          <MoreVertical size={19} color={C.faint} />
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: S.gutter,
    paddingVertical: 8,
    gap: 12,
  },
  thumb: {width: 52, height: 52, borderRadius: 6, backgroundColor: C.surface},
  thumbFallback: {backgroundColor: C.surfaceHi},
  index: {
    width: 52,
    textAlign: 'center',
    color: C.faint,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  text: {flex: 1, minWidth: 0},
  title: {...T.body, color: C.text},
  titleActive: {color: C.accent},
  metaLine: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3},
  sub: {...T.sub, color: C.sub, flex: 1},
  act: {paddingHorizontal: 5, paddingVertical: 6},
  menu: {paddingLeft: 3, paddingVertical: 6},
});
