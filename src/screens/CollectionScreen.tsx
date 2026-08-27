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
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  Modal,
  NativeModules,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  ArrowDownToLine,
  CheckSquare,
  CheckSquare2,
  ChevronLeft,
  Heart,
  ImagePlus,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  Shuffle,
  Square,
  SquareX,
  Trash2,
} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {deleteDownload, type Track} from '../backend';
import {formatTotalDuration, getBestArtworkUrl, getTrackId} from '../tracks';
import {
  collectionSubtitle,
  isSaved,
  toggleSaved,
  type Collection,
} from '../collections';
import {CollectionArt} from '../components/CollectionArt';
import {TrackRow, listWindowing} from '../components/TrackRow';
import {toast} from '../toast';
import {
  enqueueDownload,
  forgetDownloads,
  overlayDownloadArtwork,
  useDownloadJobs,
} from '../downloads';
import {DownloadRow} from '../components/DownloadRow';
import {
  State,
  setShuffle,
  togglePlay,
  useActiveTrack,
  usePlaybackState,
  useShuffle,
} from '../player';
import {useLikes} from '../store';
import {
  deletePlaylist,
  renamePlaylist,
  setPlaylistImage,
  usePlaylists,
} from '../playlists';
import {getLocalLibrary} from '../backend';
import {ConfirmModal} from '../components/ConfirmModal';
import {Sheet} from '../components/Sheet';
import {BOTTOM_INSET} from '../layout';

export function CollectionScreen({
  collection,
  loading = false,
  onClose,
  onPlay,
  onMenu,
  onChanged,
}: {
  collection: Collection;
  /** A fuller tracklist is on its way — show a spinner, not "empty". */
  loading?: boolean;
  onClose: () => void;
  onPlay: (track: Track, context: Track[]) => void;
  onMenu?: (
    track: Track,
    from?: {playlistId?: string; playlistName?: string},
  ) => void;
  /** Downloads were deleted — the owner should rescan disk. */
  onChanged?: () => void;
}) {
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(() => isSaved(collection));
  // Shared with the player sheet — see useShuffle in player.ts.
  const shuffled = useShuffle();
  // Own-playlist management, mirrored from the library's long-press sheet so a
  // playlist is editable from inside as well as from its row.
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  /**
   * LIVE tracks, not the snapshot the screen was opened with.
   *
   * The collection object App holds was built at open time — unlike a song
   * mid-list, unliking from inside Liked Songs, removing from a playlist, or
   * finishing a download changed the STORE but not this prop, so the row only
   * vanished after backing out and reopening. Each mutable kind re-reads its
   * source of truth here.
   */
  const likes = useLikes();
  const playlists = usePlaylists();
  const [localTracks, setLocalTracks] = useState<Track[] | null>(null);
  const jobs = useDownloadJobs();

  // Re-scan disk when a download finishes (and once on open) so a completed
  // song appears in the Downloads list the moment its bar completes.
  const doneCount = jobs.filter(j => j.status === 'done').length;
  useEffect(() => {
    if (collection.kind !== 'downloads') {
      return;
    }
    let alive = true;
    getLocalLibrary()
      .then(({tracks: t}) => alive && setLocalTracks(overlayDownloadArtwork(t)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [collection.kind, doneCount]);

  const tracks = useMemo(() => {
    switch (collection.kind) {
      case 'liked':
        return likes;
      case 'userPlaylist': {
        const pl = playlists.find(p => `pl:${p.id}` === collection.id);
        return pl?.tracks ?? collection.tracks;
      }
      case 'downloads':
        return localTracks ?? collection.tracks;
      default:
        return collection.tracks;
    }
  }, [collection, likes, playlists, localTracks]);
  const runtime = useMemo(() => formatTotalDuration(tracks), [tracks]);

  // A user playlist stays editable from inside, not only from its library row:
  // reflect the LIVE name and cover so a rename or new picture shows without
  // backing out, and expose the manage menu (rename / cover / delete).
  const isOwnPlaylist = collection.kind === 'userPlaylist';
  const playlistId = collection.id.replace(/^pl:/, '');
  const livePlaylist = isOwnPlaylist
    ? playlists.find(p => p.id === playlistId)
    : undefined;
  const displayName = livePlaylist?.name ?? collection.name;
  const shownCollection = useMemo(
    () =>
      livePlaylist
        ? {...collection, name: livePlaylist.name, image: livePlaylist.image}
        : collection,
    [collection, livePlaylist],
  );

  // Whether THIS collection is what's sounding right now — that's what decides
  // if the big green button means pause/resume or "start from the top".
  const activeEngine = useActiveTrack();
  const {state: playState} = usePlaybackState() as {state?: State};
  const playingHere = useMemo(() => {
    if (!activeEngine) {
      return false;
    }
    const at = String(activeEngine.title ?? '').toLowerCase();
    const aa = String(activeEngine.artist ?? '').toLowerCase();
    return tracks.some(
      t =>
        (t.title || '').toLowerCase() === at &&
        (t.artist || '').toLowerCase() === aa,
    );
  }, [activeEngine, tracks]);
  const isPlaying =
    playState === State.Playing ||
    playState === State.Buffering ||
    playState === State.Loading;

  // The header art shrinks as the list scrolls up and comes back full-size on
  // the way down — the Spotify header feel.
  const scrollY = useRef(new Animated.Value(0)).current;
  const artScale = scrollY.interpolate({
    inputRange: [0, 220],
    outputRange: [1, 0.55],
    extrapolate: 'clamp',
  });
  const artOpacity = scrollY.interpolate({
    inputRange: [0, 220],
    outputRange: [1, 0.35],
    extrapolate: 'clamp',
  });

  // Warm the image cache for the first screenful of covers, so scrolling a
  // freshly-opened playlist doesn't pop empty squares in one by one.
  useEffect(() => {
    tracks.slice(0, 12).forEach(t => {
      const art = getBestArtworkUrl(t);
      if (art) {
        Image.prefetch(art).catch(() => {});
      }
    });
  }, [tracks]);
  const selecting = selected !== null;
  const canSelect = collection.kind === 'downloads';
  // Only a playlist of the user's can offer "remove from this playlist".
  const playlistFrom =
    collection.kind === 'userPlaylist'
      ? {
          playlistId: collection.id.replace(/^pl:/, ''),
          playlistName: collection.name,
        }
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
    const forget: Track[] = [];
    for (const t of targets) {
      if (t.file_path && (await deleteDownload(t.file_path))) {
        removed += 1;
        forget.push(t);
      }
    }
    // Tell the registry and every screen listening, before the toast —
    // otherwise the rows just deleted keep their downloaded tick until
    // something else happens to rescan.
    if (forget.length) {
      forgetDownloads(forget);
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

  const play = useCallback((t: Track) => onPlay(t, tracks), [onPlay, tracks]);

  /** Queue every track for download. Sequential so the backend isn't handed
   *  fifty simultaneous fetches. */
  const downloadAll = useCallback(async () => {
    if (!tracks.length) {
      return;
    }
    toast(`Downloading ${tracks.length} songs…`);
    for (const t of tracks) {
      try {
        await enqueueDownload(t);
      } catch {
        /* skip the ones with no downloadable source */
      }
    }
  }, [tracks]);

  const changeCover = useCallback(async () => {
    setMenuOpen(false);
    const native = NativeModules.Backend as {pickImage?: () => Promise<string>};
    if (typeof native.pickImage !== 'function') {
      toast('Changing the cover needs the newest APK.');
      return;
    }
    try {
      const uri = await native.pickImage();
      if (uri) {
        setPlaylistImage(playlistId, uri);
        toast('Cover updated');
      }
    } catch {
      toast('Could not use that image');
    }
  }, [playlistId]);

  const submitRename = useCallback(() => {
    const clean = renameText.trim();
    if (clean) {
      renamePlaylist(playlistId, clean);
      toast('Playlist renamed');
    }
    setRenaming(false);
    setRenameText('');
  }, [renameText, playlistId]);

  const doDelete = useCallback(() => {
    setConfirmDelete(false);
    deletePlaylist(playlistId);
    toast(`Deleted ${displayName}`);
    onClose();
  }, [playlistId, displayName, onClose]);

  /**
   * Shuffle reorders what comes NEXT without touching the current song when
   * this collection is already playing; otherwise it starts playback from a
   * random track. Either way the icon goes green to say the order is shuffled.
   */
  const shuffle = useCallback(async () => {
    if (!tracks.length) {
      return;
    }
    const next = !shuffled;
    if (!next) {
      // Toggling OFF: put the upcoming tracks back in their original order.
      await setShuffle(false).catch(() => {});
      toast('Shuffle off');
      return;
    }
    if (playingHere) {
      await setShuffle(true).catch(() => {});
      toast('Shuffled what comes next');
    } else {
      onPlay(tracks[Math.floor(Math.random() * tracks.length)], tracks);
      // Give the queue a beat to build before shuffling its tail.
      setTimeout(() => setShuffle(true).catch(() => {}), 600);
    }
  }, [onPlay, tracks, playingHere, shuffled]);

  /** The green button: pause/resume when this collection is playing, start it
   *  otherwise — never a dead control. */
  const onBigPlay = useCallback(() => {
    if (!tracks.length) {
      return;
    }
    if (playingHere) {
      togglePlay().catch(() => {});
    } else {
      play(tracks[0]);
    }
  }, [tracks, playingHere, play]);

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
            {/* An icon, not a word — the header beside it already says
                "n selected", so this only has to say what tapping does. The
                accessibility label carries the meaning that the text used to,
                because an unlabelled glyph is invisible to a screen reader in a
                way the words never were. */}
            <TouchableOpacity
              onPress={toggleAll}
              hitSlop={10}
              style={styles.selectAll}
              accessibilityRole="button"
              accessibilityLabel={
                allSelected ? 'Clear the selection' : 'Select all songs'
              }>
              {allSelected ? (
                <SquareX size={22} color={C.accent} />
              ) : (
                <CheckSquare2 size={22} color={C.accent} />
              )}
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
          <>
            <Text style={styles.barTitle} numberOfLines={1}>
              {displayName}
            </Text>
            {isOwnPlaylist && (
              <TouchableOpacity
                onPress={() => setMenuOpen(true)}
                hitSlop={12}
                style={styles.barBtn}>
                <MoreVertical size={22} color={C.text} />
              </TouchableOpacity>
            )}
          </>
        )}
      </View>

      <Animated.FlatList
        data={tracks}
        keyExtractor={t => getTrackId(t)}
        {...listWindowing}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        onScroll={Animated.event(
          [{nativeEvent: {contentOffset: {y: scrollY}}}],
          {useNativeDriver: true},
        )}
        scrollEventThrottle={16}
        ListHeaderComponent={
          <View style={styles.header}>
            <Animated.View
              style={{transform: [{scale: artScale}], opacity: artOpacity}}>
              <CollectionArt collection={shownCollection} size={168} />
            </Animated.View>
            <Text style={styles.name} numberOfLines={2}>
              {displayName}
            </Text>
            <Text style={styles.sub}>
              {collectionSubtitle(collection)}
              {runtime ? ` · ${runtime}` : ''}
            </Text>

            {collection.kind === 'downloads' && jobs.length > 0 && (
              <View style={styles.jobs}>
                {jobs.map(j => (
                  <DownloadRow key={j.taskId} job={j} />
                ))}
              </View>
            )}

            {/* Left group, play hard right — the two ends of the row, so
                neither reads as the other's neighbour. An album gets save +
                download-all instead of shuffle; shuffling a fixed running
                order is not what you want from a record. */}
            {!selecting && (
              <View style={styles.actions}>
                <View style={styles.leftGroup}>
                  {/* Anything that came from a SOURCE (album or playlist) can
                      be saved to the library with the heart — that's how it
                      shows up under Your Library, same as Spotify. */}
                  {(collection.kind === 'album' ||
                    collection.kind === 'sourcePlaylist') && (
                    <TouchableOpacity
                      activeOpacity={0.7}
                      hitSlop={10}
                      onPress={() => {
                        const now = toggleSaved(collection);
                        setSaved(now);
                        toast(
                          now
                            ? `Saved ${collection.name}`
                            : `Removed ${collection.name}`,
                        );
                      }}>
                      <Heart
                        size={24}
                        color={saved ? C.accent : C.text}
                        fill={saved ? C.accent : 'transparent'}
                      />
                    </TouchableOpacity>
                  )}
                  {/* Download-all: every album and playlist can be taken
                      offline in one tap. A record keeps its fixed order so it
                      gets no shuffle; a playlist gets both. */}
                  {(collection.kind === 'album' ||
                    collection.kind === 'userPlaylist' ||
                    collection.kind === 'sourcePlaylist') && (
                    <TouchableOpacity
                      activeOpacity={0.7}
                      hitSlop={10}
                      onPress={downloadAll}
                      disabled={!tracks.length}>
                      <ArrowDownToLine
                        size={24}
                        color={tracks.length ? C.text : C.faint}
                      />
                    </TouchableOpacity>
                  )}
                  {collection.kind !== 'album' && (
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={shuffle}
                      hitSlop={12}
                      disabled={!tracks.length}>
                      <Shuffle
                        size={24}
                        color={
                          shuffled ? C.accent : tracks.length ? C.text : C.faint
                        }
                      />
                    </TouchableOpacity>
                  )}
                </View>
                <TouchableOpacity
                  style={styles.playBtn}
                  activeOpacity={0.85}
                  onPress={onBigPlay}
                  disabled={!tracks.length}>
                  {playingHere && isPlaying ? (
                    <Pause size={26} color={C.bg} fill={C.bg} />
                  ) : (
                    <Play
                      size={26}
                      color={C.bg}
                      fill={C.bg}
                      style={styles.playNudge}
                    />
                  )}
                </TouchableOpacity>
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator color={C.accent} />
              <Text style={styles.empty}>Loading songs…</Text>
            </View>
          ) : (
            <Text style={styles.empty}>
              {collection.kind === 'downloads'
                ? 'Nothing downloaded yet. Songs you download are kept here and play offline.'
                : collection.kind === 'liked'
                ? 'Songs you like will show up here.'
                : 'This list is empty.'}
            </Text>
          )
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
                  onPress={() => (selecting ? toggleOne(item) : play(item))}
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

      {/* Manage this playlist — same options as the library's long-press sheet,
          reachable from inside the playlist too. */}
      <Sheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        style={styles.sheet}>
        <View>
          <Text style={styles.sheetTitle} numberOfLines={1}>
            {displayName}
          </Text>
          <TouchableOpacity
            style={styles.sheetRow}
            activeOpacity={0.7}
            onPress={() => {
              setRenameText(displayName);
              setMenuOpen(false);
              setRenaming(true);
            }}>
            <Pencil size={20} color={C.sub} />
            <Text style={styles.sheetLabel}>Rename</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.sheetRow}
            activeOpacity={0.7}
            onPress={changeCover}>
            <ImagePlus size={20} color={C.sub} />
            <Text style={styles.sheetLabel}>Change cover</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.sheetRow}
            activeOpacity={0.7}
            onPress={() => {
              setMenuOpen(false);
              setConfirmDelete(true);
            }}>
            <Trash2 size={20} color={C.danger} />
            <Text style={[styles.sheetLabel, styles.sheetDanger]}>
              Delete playlist
            </Text>
          </TouchableOpacity>
        </View>
      </Sheet>

      {/* Rename dialog. Stays a <Modal>: a TextInput dialog wants a real window
          for soft-keyboard focus and insets. See LibraryScreen for the full
          reasoning. */}
      <Modal
        visible={renaming}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setRenaming(false)}>
        <View style={styles.dialogScrim}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>Rename playlist</Text>
            <TextInput
              value={renameText}
              onChangeText={setRenameText}
              placeholder="New name"
              placeholderTextColor={C.faint}
              style={styles.input}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={submitRename}
            />
            <View style={styles.dialogRow}>
              <TouchableOpacity
                onPress={() => setRenaming(false)}
                style={styles.dialogBtn}>
                <Text style={styles.dialogCancel}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={submitRename}
                disabled={!renameText.trim()}
                style={styles.dialogBtn}>
                <Text
                  style={[
                    styles.dialogOk,
                    !renameText.trim() && styles.dialogDisabled,
                  ]}>
                  Save
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <ConfirmModal
        visible={confirmDelete}
        title={`Delete "${displayName}"?`}
        message="The songs themselves are not touched."
        confirmLabel="Delete"
        danger
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
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
  selectAll: {paddingHorizontal: 8, paddingVertical: 6},
  // The bars at the foot of the app float OVER the page now, so a list has to
  // end above them or its last row is permanently behind one. See src/layout.ts.
  list: {paddingBottom: BOTTOM_INSET},
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
  jobs: {alignSelf: 'stretch', paddingTop: 14},
  leftGroup: {flexDirection: 'row', alignItems: 'center', gap: 22},
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
  loadingBox: {alignItems: 'center', paddingTop: 26},
  // Background, rounded top, padding, scrim and handle all live in <Sheet>.
  sheet: {},
  sheetTitle: {
    ...T.rowTitle,
    color: C.text,
    paddingHorizontal: S.gutter,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: S.gutter,
    paddingVertical: 14,
  },
  sheetLabel: {fontSize: 15, color: C.text},
  sheetDanger: {color: C.danger},
  dialogScrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  dialog: {
    width: '100%',
    borderRadius: 14,
    backgroundColor: C.surfaceHi,
    padding: 20,
  },
  dialogTitle: {...T.rowTitle, color: C.text, marginBottom: 14},
  input: {
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    color: C.text,
    fontSize: 16,
    paddingVertical: 8,
  },
  dialogRow: {flexDirection: 'row', justifyContent: 'flex-end', marginTop: 18},
  dialogBtn: {paddingHorizontal: 14, paddingVertical: 8},
  dialogCancel: {color: C.sub, fontSize: 14, fontWeight: '700'},
  dialogOk: {color: C.accent, fontSize: 14, fontWeight: '700'},
  dialogDisabled: {color: C.faint},
});
