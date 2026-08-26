/**
 * The bottom sheet behind every row's ⋮ (and a long-press).
 *
 * A phone has no right-click and no hover, so every per-track action lives
 * here as a thumb-sized list.
 *
 * `from` is the list the ⋮ was tapped in — {playlistId, playlistName} when
 * that's a playlist of yours, otherwise null. That's what lets this offer
 * "Remove from this playlist"; opened from search or an album there is nothing
 * to remove the song from, so the row simply isn't there.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  Check,
  Disc3,
  Download,
  Heart,
  ListPlus,
  ListX,
  Loader,
  Trash2,
  User,
} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {deleteDownload, type Track} from '../backend';
import {enqueueDownload, forgetDownloads} from '../downloads';
import {cleanText, getBestArtworkUrl} from '../tracks';
import {isLiked, toggleLike} from '../store';
import {removeTrackFromPlaylist} from '../playlists';
import {addToQueue} from '../player';
import {toast} from '../toast';
import {Sheet} from './Sheet';

export type SheetContext = {
  playlistId?: string;
  playlistName?: string;
} | null;

export function TrackActionSheet({
  track,
  from,
  onClose,
  onAddToPlaylist,
  onOpenArtist,
  onOpenAlbum,
}: {
  track: Track | null;
  from?: SheetContext;
  onClose: () => void;
  onAddToPlaylist: (t: Track) => void;
  onOpenArtist: (t: Track) => void;
  onOpenAlbum: (t: Track) => void;
}) {
  const [liked, setLiked] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * The last track this was opened for, held through the close animation.
   *
   * `track` goes null the instant the sheet is dismissed. Rendering straight
   * off it would empty the sheet mid-slide, so an EMPTY panel would finish
   * sliding away — which the Modal hid, because a Modal is torn down whole.
   */
  const [shown, setShown] = useState<Track | null>(track);

  useEffect(() => {
    setLiked(track ? isLiked(track) : false);
    if (track) {
      setShown(track);
    }
  }, [track]);

  const run = useCallback(
    (fn: () => void) => () => {
      fn();
      onClose();
    },
    [onClose],
  );

  const download = useCallback(async () => {
    if (!track) {
      return;
    }
    setBusy(true);
    try {
      await enqueueDownload(track);
      toast(`Downloading "${cleanText(track.title)}"`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not start that download');
    } finally {
      setBusy(false);
      onClose();
    }
  }, [track, onClose]);

  const removeDownload = useCallback(async () => {
    if (!track?.file_path) {
      return;
    }
    const ok = await deleteDownload(track.file_path);
    // Either way the file is not there any more, so the registry must not go on
    // claiming it is: "already gone" is still gone.
    forgetDownloads([track]);
    toast(
      ok ? 'Removed from downloads' : 'Removed (the file was already gone)',
    );
    onClose();
  }, [track, onClose]);

  if (!shown) {
    return null;
  }
  // Everything below renders from `shown`, not `track` — see the note on it.
  const t = shown;
  const downloaded = !!t.file_path;
  const artwork = getBestArtworkUrl(t);

  const items: Array<{
    key: string;
    Icon: typeof Heart;
    label: string;
    onPress: () => void;
    tint?: string;
    /** Keep the sheet open — used by Like, so you can see it take. */
    stay?: boolean;
  }> = [
    {
      key: 'like',
      Icon: liked ? Check : Heart,
      label: liked ? 'Remove from Liked Songs' : 'Add to Liked Songs',
      tint: liked ? C.accent : undefined,
      stay: true,
      onPress: () => {
        toggleLike(t);
        setLiked(v => !v);
      },
    },
    downloaded
      ? {
          key: 'undownload',
          Icon: Trash2,
          label: 'Remove download',
          onPress: removeDownload,
        }
      : {
          key: 'download',
          Icon: busy ? Loader : Download,
          label: busy ? 'Starting…' : 'Download',
          onPress: download,
        },
    {
      key: 'queue',
      Icon: ListPlus,
      label: 'Add to queue',
      onPress: run(() => {
        addToQueue(t)
          .then(() => toast('Added to queue'))
          .catch(() => toast('Nothing is playing yet'));
      }),
    },
    {
      key: 'playlist',
      Icon: ListPlus,
      label: 'Add to playlist',
      onPress: run(() => onAddToPlaylist(t)),
    },
    ...(from?.playlistId
      ? [
          {
            key: 'remove',
            Icon: ListX,
            label: `Remove from ${
              cleanText(from.playlistName) || 'this playlist'
            }`,
            onPress: run(() => {
              removeTrackFromPlaylist(from.playlistId as string, t);
              toast('Removed from playlist');
            }),
          },
        ]
      : []),
    {
      key: 'artist',
      Icon: User,
      label: 'Go to artist',
      onPress: run(() => onOpenArtist(t)),
    },
    ...(t.album
      ? [
          {
            key: 'album',
            Icon: Disc3,
            label: 'Go to album',
            onPress: run(() => onOpenAlbum(t)),
          },
        ]
      : []),
  ];

  return (
    <Sheet open={!!track} onClose={onClose} style={styles.sheet}>
      <View style={styles.head}>
        {artwork ? (
          <Image source={{uri: artwork}} style={styles.art} />
        ) : (
          <View style={[styles.art, styles.artEmpty]} />
        )}
        <View style={styles.headText}>
          <Text style={styles.headTitle} numberOfLines={1}>
            {cleanText(t.title)}
          </Text>
          <Text style={styles.headSub} numberOfLines={1}>
            {cleanText(t.artist)}
          </Text>
        </View>
      </View>

      <ScrollView style={styles.list} bounces={false}>
        {items.map(({key, Icon, label, onPress, tint}) => (
          <TouchableOpacity
            key={key}
            style={styles.row}
            activeOpacity={0.7}
            onPress={onPress}>
            <Icon size={20} color={tint || C.sub} />
            <Text style={styles.rowLabel}>{label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // Scrim, handle, rounded top and the slide all live in <Sheet> now.
  sheet: {maxHeight: '72%'},
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: S.gutter,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  art: {width: 46, height: 46, borderRadius: 4, backgroundColor: C.surface},
  artEmpty: {backgroundColor: C.bg},
  headText: {flex: 1, minWidth: 0},
  headTitle: {...T.body, color: C.text},
  headSub: {...T.sub, color: C.sub, marginTop: 2},
  list: {flexGrow: 0},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: S.gutter,
    paddingVertical: 14,
  },
  rowLabel: {fontSize: 15, color: C.text},
});
