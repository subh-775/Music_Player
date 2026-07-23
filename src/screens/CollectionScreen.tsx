/**
 * One screen for every collection: album, playlist, Liked Songs, Downloads.
 *
 * There used to be two of these (CollectionScreen and TrackListScreen) and they
 * had already drifted — one had shuffle, the other didn't. Since every list of
 * songs is now the same object, it renders through one path.
 *
 * Downloads additionally supports select-and-delete: hold a row to enter
 * selection, then remove the files from the phone's storage.
 */
import React, {useCallback, useMemo, useState} from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  CheckSquare,
  ChevronLeft,
  Play,
  Shuffle,
  Square,
  Trash2,
} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {deleteDownload, type Track} from '../backend';
import {formatTotalDuration, getTrackId} from '../tracks';
import {
  collectionSubtitle,

  type Collection,
} from '../collections';
import {CollectionArt} from '../components/CollectionArt';
import {TrackRow} from '../components/TrackRow';
import {toast} from '../toast';

export function CollectionScreen({
  collection,
  onClose,
  onPlay,
  onMenu,
  onChanged,
}: {
  collection: Collection;
  onClose: () => void;
  onPlay: (track: Track, context: Track[]) => void;
  onMenu?: (track: Track, from?: {playlistId?: string; playlistName?: string}) => void;
  /** Downloads were deleted — the owner should rescan disk. */
  onChanged?: () => void;
}) {
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);

  const tracks = collection.tracks;
  const runtime = useMemo(() => formatTotalDuration(tracks), [tracks]);
  const selecting = selected !== null;
  const canSelect = collection.kind === 'downloads';
  // Only a playlist of the user's can offer "remove from this playlist".
  const playlistFrom =
    collection.kind === 'userPlaylist'
      ? {playlistId: collection.id.replace(/^pl:/, ''), playlistName: collection.name}
      : undefined;

  const toggleOne = useCallback((t: Track) => {
    setSelected(prev => {
      const next = new Set(prev ?? []);
      const id = getTrackId(t);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const allSelected = selecting && selected.size === tracks.length;

  const toggleAll = useCallback(() => {
    setSelected(allSelected ? new Set() : new Set(tracks.map(getTrackId)));
  }, [allSelected, tracks]);

  const deleteSelected = useCallback(async () => {
    if (!selected?.size) {
      return;
    }
    setBusy(true);
    const targets = tracks.filter(t => selected.has(getTrackId(t)));
    // Sequential, not parallel: each delete may also remove a now-empty album
    // folder, and two of those racing on the same folder is how you get a
    // spurious failure on a delete that actually worked.
    let removed = 0;
    for (const t of targets) {
      if (t.file_path && (await deleteDownload(t.file_path))) {
        removed += 1;
      }
    }
    setBusy(false);
    setSelected(null);
    toast(
      removed === targets.length
        ? `Deleted ${removed} song${removed === 1 ? '' : 's'}`
        : `Deleted ${removed} of ${targets.length} — some files were already gone`,
    );
    onChanged?.();
  }, [selected, tracks, onChanged]);

  const play = useCallback(
    (t: Track) => onPlay(t, tracks),
    [onPlay, tracks],
  );

  const shuffle = useCallback(() => {
    if (!tracks.length) {
      return;
    }
    const start = tracks[Math.floor(Math.random() * tracks.length)];
    onPlay(start, tracks);
  }, [onPlay, tracks]);

  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        <TouchableOpacity
          onPress={selecting ? () => setSelected(null) : onClose}
          hitSlop={12}
          style={styles.barBtn}>
          <ChevronLeft size={28} color={C.text} />
        </TouchableOpacity>

        {selecting ? (
          <>
            <Text style={styles.barTitle}>{selected.size} selected</Text>
            <TouchableOpacity onPress={toggleAll} style={styles.selectAll}>
              <Text style={styles.selectAllText}>
                {allSelected ? 'Clear' : 'Select all'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={deleteSelected}
              disabled={busy || !selected.size}
              hitSlop={10}
              style={styles.barBtn}>
              <Trash2
                size={22}
                color={selected.size && !busy ? C.danger : C.faint}
              />
            </TouchableOpacity>
          </>
        ) : (
          <Text style={styles.barTitle} numberOfLines={1}>
            {collection.name}
          </Text>
        )}
      </View>

      <FlatList
        data={tracks}
        keyExtractor={(t, i) => `${getTrackId(t)}-${i}`}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View style={styles.header}>
            <CollectionArt collection={collection} size={168} />
            <Text style={styles.name} numberOfLines={2}>
              {collection.name}
            </Text>
            <Text style={styles.sub}>
              {collectionSubtitle(collection)}
              {runtime ? ` · ${runtime}` : ''}
            </Text>

            {/* Shuffle hard left, play hard right — the two ends of the row,
                so neither reads as the other's neighbour. */}
            {!selecting && (
              <View style={styles.actions}>
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={shuffle}
                  hitSlop={12}
                  disabled={!tracks.length}>
                  <Shuffle size={24} color={tracks.length ? C.text : C.faint} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.playBtn}
                  activeOpacity={0.85}
                  onPress={() => tracks.length && play(tracks[0])}
                  disabled={!tracks.length}>
                  <Play size={26} color={C.bg} fill={C.bg} style={styles.playNudge} />
                </TouchableOpacity>
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          <Text style={styles.empty}>
            {collection.kind === 'downloads'
              ? 'Nothing downloaded yet. Songs you download are kept here and play offline.'
              : collection.kind === 'liked'
              ? 'Songs you like will show up here.'
              : 'This list is empty.'}
          </Text>
        }
        renderItem={({item}) => {
          const id = getTrackId(item);
          const checked = selecting && selected.has(id);
          return (
            <View style={styles.rowWrap}>
              {selecting && (
                <TouchableOpacity
                  onPress={() => toggleOne(item)}
                  hitSlop={10}
                  style={styles.check}>
                  {checked ? (
                    <CheckSquare size={22} color={C.accent} />
                  ) : (
                    <Square size={22} color={C.faint} />
                  )}
                </TouchableOpacity>
              )}
              <View style={styles.rowFill}>
                <TrackRow
                  track={item}
                  onPress={() =>
                    selecting ? toggleOne(item) : play(item)
                  }
                  onLongPress={
                    canSelect && !selecting
                      ? () => setSelected(new Set([id]))
                      : onMenu
                      ? () => onMenu(item, playlistFrom)
                      : undefined
                  }
                  onMenu={
                    onMenu && !selecting
                      ? () => onMenu(item, playlistFrom)
                      : undefined
                  }
                  showActions={!selecting}
                />
              </View>
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1, backgroundColor: C.bg},
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 12,
    paddingHorizontal: 8,
    paddingBottom: 4,
    gap: 4,
  },
  barBtn: {padding: 4},
  barTitle: {...T.rowTitle, color: C.text, flex: 1, fontSize: 17},
  selectAll: {paddingHorizontal: 10, paddingVertical: 6},
  selectAllText: {...T.sub, color: C.accent, fontWeight: '700'},
  list: {paddingBottom: 20},
  header: {alignItems: 'center', paddingTop: 10, paddingBottom: 6},
  name: {
    ...T.screenTitle,
    color: C.text,
    marginTop: 16,
    textAlign: 'center',
    paddingHorizontal: S.gutter,
  },
  sub: {...T.sub, color: C.sub, marginTop: 5},
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
    paddingHorizontal: S.gutter,
    marginTop: 18,
    marginBottom: 6,
  },
  playNudge: {marginLeft: 3},
  playBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowWrap: {flexDirection: 'row', alignItems: 'center'},
  rowFill: {flex: 1, minWidth: 0},
  check: {paddingLeft: S.gutter, paddingVertical: 12},
  empty: {
    color: C.faint,
    textAlign: 'center',
    paddingHorizontal: 40,
    paddingVertical: 34,
    fontSize: 13,
    lineHeight: 19,
  },
});
