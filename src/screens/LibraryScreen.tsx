/**
 * Your Library.
 *
 * Every row here is a Collection (see collections.ts) — Liked Songs, your
 * Downloads, saved albums and your own playlists are the same object rendered
 * by the same row, so tapping any of them opens the same screen and plays the
 * same way.
 *
 * Long-press pins a row to the top, up to five.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  NativeModules,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {ImagePlus, Pencil, Plus, Trash2} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {PinGlyph} from '../components/PinGlyph';
import {getLocalLibrary, type Track} from '../backend';
import {useLikes} from '../store';
import {useFollowedArtists} from '../artists';
import {collectionSubtitle, useLibrary, type Collection} from '../collections';
import {
  createPlaylist,
  deletePlaylist,
  renamePlaylist,
  setPlaylistImage,
} from '../playlists';
import {
  MAX_PINS,
  isPinned,
  rowId,
  sortPinned,
  togglePin,
  usePins,
} from '../pins';
import {CollectionArt, DOWNLOAD_TINT} from '../components/CollectionArt';
import {
  markDownloaded,
  onDownloadsChanged,
  overlayDownloadArtwork,
} from '../downloads';
import {usePlaybackOrigin} from '../player';
import {toast} from '../toast';
import {Sheet} from '../components/Sheet';
import {listWindowing} from '../components/TrackRow';
import {BOTTOM_INSET} from '../layout';

type Filter = 'all' | 'playlists' | 'albums' | 'artists';

const FILTERS: Array<{id: Filter; label: string}> = [
  {id: 'all', label: 'All'},
  {id: 'playlists', label: 'Playlists'},
  {id: 'albums', label: 'Albums'},
  {id: 'artists', label: 'Artists'},
];

/** Pins key off the row's kind, so a playlist and an album that happen to share
 *  a name can be pinned independently. */
function idOf(c: Collection): string {
  return rowId(c.kind === 'album' ? 'album' : 'playlist', {
    id: c.id,
    name: c.name,
    artist: c.artist,
  });
}

/**
 * Memoised, and this is not a micro-optimisation.
 *
 * App holds twenty-odd useState hooks in ONE component, and all three tab
 * screens, the full player, the mini player and the drawer are its children —
 * so opening a sheet, closing an overlay or touching any of them re-rendered
 * every one of these trees. That is what "the app freezes for a moment" was:
 * not work being done, but work being redone. Every prop below is
 * useCallback-stable in App, so this actually holds.
 */
export const LibraryScreen = React.memo(function LibraryScreen({
  onOpen,
  visible = true,
}: {
  onOpen: (c: Collection) => void;
  /** The tab stays mounted now; this flags when it's actually on screen so
   *  downloads can re-scan quietly without a full-screen spinner. */
  visible?: boolean;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [downloads, setDownloads] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  /** The row a long-press opened options for. */
  const [menuFor, setMenuFor] = useState<Collection | null>(null);
  const [renaming, setRenaming] = useState<Collection | null>(null);
  const [renameText, setRenameText] = useState('');

  const likes = useLikes();
  const pins = usePins();
  const artists = useFollowedArtists();
  const library = useLibrary(likes, downloads);

  /**
   * Which collection playback was STARTED from — its title renders green, so
   * the library answers "what am I listening to" at a glance.
   *
   * This used to ask which collections CONTAIN the playing song, which is a
   * different question: one song is typically in Liked Songs, a playlist and
   * Downloads all at once, so all three lit up together and the highlight meant
   * nothing. Containment cannot tell them apart — only the origin can.
   */
  const origin = usePlaybackOrigin();
  const isPlayingFrom = useCallback(
    (c: Collection) => {
      return !!origin && c.id === origin;
    },
    [origin],
  );

  // Followed artists render as rows too, so one list handles everything.
  const withArtists = useMemo(
    () => [
      ...library,
      ...artists.map(a => ({
        id: `artist:${a.name}`,
        kind: 'artist' as const,
        name: a.name,
        image: a.image,
        tracks: [],
      })),
    ],
    [library, artists],
  );

  const loadDownloads = useCallback(async () => {
    try {
      const {tracks} = await getLocalLibrary();
      // The disk scan carries no artwork; lay back the covers remembered at
      // download time so offline rows aren't blank squares.
      setDownloads(overlayDownloadArtwork(tracks));
      // The scan is also the truth about what's downloaded — keep the
      // "already downloaded" set in step with the actual files.
      markDownloaded(tracks);
    } catch {
      // Offline library unavailable — the rest of the library still works.
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-scan whenever the tab comes on screen. Only the FIRST scan shows the
  // spinner (`loading` starts true); later ones swap the data in quietly, so
  // returning to the tab is instant.
  useEffect(() => {
    if (visible) {
      loadDownloads();
    }
  }, [visible, loadDownloads]);

  // …and whenever a download actually lands, on screen or not. Waiting for a
  // tab visit is why a song downloaded from Search still offered "Download"
  // afterwards, and why the Downloaded collection was a scan behind.
  useEffect(() => onDownloadsChanged(loadDownloads), [loadDownloads]);

  const rows = useMemo(() => {
    const matches = (c: Collection) => {
      switch (filter) {
        case 'playlists':
          return (
            c.kind === 'userPlaylist' ||
            c.kind === 'sourcePlaylist' ||
            c.kind === 'liked'
          );
        case 'albums':
          return c.kind === 'album';
        case 'artists':
          return c.kind === 'artist';
        default:
          return true;
      }
    };
    // Liked Songs and Downloaded are fixtures: always first, in that order.
    // Pins reorder only what comes after them.
    const list = withArtists.filter(matches);
    const fixed = list.filter(
      c => c.kind === 'liked' || c.kind === 'downloads',
    );
    const rest = list.filter(c => c.kind !== 'liked' && c.kind !== 'downloads');
    return [...fixed, ...sortPinned(rest, pins, idOf)];
  }, [withArtists, pins, filter]);

  /** Only playlists pin — not artists, not albums, and not the fixtures. */
  const canPin = (c: Collection) =>
    c.kind === 'userPlaylist' || c.kind === 'sourcePlaylist';

  /** Long-press opens the options sheet; what's in it depends on the row. */
  const onLongPress = useCallback((c: Collection) => {
    if (c.kind === 'liked' || c.kind === 'downloads' || c.kind === 'artist') {
      return;
    }
    if (c.kind === 'album') {
      return; // nothing to offer yet — albums unsave from their own screen
    }
    setMenuFor(c);
  }, []);

  const doPin = useCallback((c: Collection) => {
    const result = togglePin(idOf(c));
    if (result === 'full') {
      toast(`You can pin up to ${MAX_PINS}. Unpin one first.`);
    } else {
      toast(result === 'pinned' ? `Pinned ${c.name}` : `Unpinned ${c.name}`);
    }
    setMenuFor(null);
  }, []);

  const playlistIdOf = (c: Collection) => c.id.replace(/^pl:/, '');

  const doChangeCover = useCallback(async (c: Collection) => {
    setMenuFor(null);
    const native = NativeModules.Backend as {pickImage?: () => Promise<string>};
    if (typeof native.pickImage !== 'function') {
      toast('Changing the cover needs the newest APK.');
      return;
    }
    try {
      const uri = await native.pickImage();
      if (uri) {
        setPlaylistImage(playlistIdOf(c), uri);
        toast('Cover updated');
      }
    } catch {
      toast('Could not use that image');
    }
  }, []);

  const doDelete = useCallback((c: Collection) => {
    setMenuFor(null);
    Alert.alert(
      `Delete "${c.name}"?`,
      'The songs themselves are not touched.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deletePlaylist(playlistIdOf(c));
            toast(`Deleted ${c.name}`);
          },
        },
      ],
    );
  }, []);

  const submitRename = useCallback(() => {
    if (renaming && renameText.trim()) {
      renamePlaylist(playlistIdOf(renaming), renameText.trim());
      toast('Playlist renamed');
    }
    setRenaming(null);
    setRenameText('');
  }, [renaming, renameText]);

  const submitNew = useCallback(() => {
    const pl = createPlaylist(newName);
    setCreating(false);
    setNewName('');
    if (pl) {
      toast(`Created "${pl.name}"`);
    }
  }, [newName]);

  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        <Text style={styles.title}>Your Library</Text>
        <TouchableOpacity
          onPress={() => setCreating(true)}
          hitSlop={12}
          style={styles.barBtn}>
          <Plus size={26} color={C.text} strokeWidth={2.2} />
        </TouchableOpacity>
      </View>

      <View style={styles.chips}>
        {FILTERS.map(f => {
          const on = filter === f.id;
          return (
            <TouchableOpacity
              key={f.id}
              activeOpacity={0.75}
              onPress={() => setFilter(f.id)}
              style={[styles.chip, on && styles.chipOn]}>
              <Text style={[styles.chipText, on && styles.chipTextOn]}>
                {f.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={C.accent} />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={c => c.id}
          {...listWindowing}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <Text style={styles.empty}>Nothing here yet.</Text>
          }
          renderItem={({item}) => (
            <TouchableOpacity
              style={styles.row}
              activeOpacity={0.7}
              onPress={() => onOpen(item)}
              onLongPress={() => onLongPress(item)}
              delayLongPress={350}>
              <CollectionArt collection={item} size={56} />
              <View style={styles.rowText}>
                <Text
                  style={[
                    styles.rowTitle,
                    isPlayingFrom(item) && styles.rowTitlePlaying,
                  ]}
                  numberOfLines={1}>
                  {item.name}
                </Text>
                <View style={styles.metaLine}>
                  {/* Liked Songs and Downloads carry the pin too. They are
                      pinned — permanently, by construction, above everything
                      the pin list can reorder — and a row that sits at the top
                      of the list with no mark on it reads as an accident. */}
                  {(isPinned(idOf(item)) ||
                    item.kind === 'liked' ||
                    item.kind === 'downloads') && (
                    <View style={styles.pin}>
                      <PinGlyph size={12} color={DOWNLOAD_TINT} />
                    </View>
                  )}
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {collectionSubtitle(item)}
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
          )}
        />
      )}

      {/* Long-press options: pin, and for your own playlists rename / cover /
          delete. A sheet, not an instant action — pinning by accident was
          worse than one extra tap. */}
      <Sheet
        open={!!menuFor}
        onClose={() => setMenuFor(null)}
        style={styles.sheet}>
        {menuFor && (
          <View>
            <Text style={styles.sheetTitle} numberOfLines={1}>
              {menuFor.name}
            </Text>
            {canPin(menuFor) && (
              <TouchableOpacity
                style={styles.sheetRow}
                activeOpacity={0.7}
                onPress={() => doPin(menuFor)}>
                <PinGlyph size={19} color={C.sub} />
                <Text style={styles.sheetLabel}>
                  {isPinned(idOf(menuFor)) ? 'Unpin' : 'Pin'}
                </Text>
              </TouchableOpacity>
            )}
            {menuFor.kind === 'userPlaylist' && (
              <>
                <TouchableOpacity
                  style={styles.sheetRow}
                  activeOpacity={0.7}
                  onPress={() => {
                    setRenaming(menuFor);
                    setRenameText(menuFor.name);
                    setMenuFor(null);
                  }}>
                  <Pencil size={20} color={C.sub} />
                  <Text style={styles.sheetLabel}>Rename</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.sheetRow}
                  activeOpacity={0.7}
                  onPress={() => doChangeCover(menuFor)}>
                  <ImagePlus size={20} color={C.sub} />
                  <Text style={styles.sheetLabel}>Change cover</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.sheetRow}
                  activeOpacity={0.7}
                  onPress={() => doDelete(menuFor)}>
                  <Trash2 size={20} color={C.danger} />
                  <Text style={[styles.sheetLabel, styles.sheetDanger]}>
                    Delete playlist
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}
      </Sheet>

      {/* Rename dialog — same shape as "New playlist". These two stay <Modal>
          on purpose: a dialog with a TextInput wants a real window so the soft
          keyboard gets proper focus and inset handling. What a Modal costs is
          its open/close window transaction, and that matters for a sheet you
          flick open constantly, not for a dialog you type into. */}
      <Modal
        visible={!!renaming}
        transparent
        animationType="fade"
        // statusBarTranslucent, like every other dialog in the app. Without
        // it the modal window stops at the status bar and leaves an
        // un-scrimmed band across the top, which reads as the dialog being
        // misaligned rather than as a window boundary.
        statusBarTranslucent
        onRequestClose={() => setRenaming(null)}>
        <View style={styles.scrim}>
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
                onPress={() => {
                  setRenaming(null);
                  setRenameText('');
                }}
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

      <Modal
        visible={creating}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setCreating(false)}>
        <View style={styles.scrim}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>New playlist</Text>
            <TextInput
              value={newName}
              onChangeText={setNewName}
              placeholder="Give it a name"
              placeholderTextColor={C.faint}
              style={styles.input}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={submitNew}
            />
            <View style={styles.dialogRow}>
              <TouchableOpacity
                onPress={() => {
                  setCreating(false);
                  setNewName('');
                }}
                style={styles.dialogBtn}>
                <Text style={styles.dialogCancel}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={submitNew}
                disabled={!newName.trim()}
                style={styles.dialogBtn}>
                <Text
                  style={[
                    styles.dialogOk,
                    !newName.trim() && styles.dialogDisabled,
                  ]}>
                  Create
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {flex: 1, backgroundColor: C.bg},
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: S.gutter,
    paddingTop: 14,
    paddingBottom: 10,
    gap: 14,
  },
  title: {...T.screenTitle, color: C.text, flex: 1},
  barBtn: {padding: 2},
  chips: {
    flexDirection: 'row',
    gap: 9,
    paddingHorizontal: S.gutter,
    paddingBottom: 12,
  },
  chip: {
    paddingHorizontal: 15,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: C.surfaceHi,
  },
  chipOn: {backgroundColor: C.text},
  chipText: {...T.sub, color: C.text, fontSize: 13},
  chipTextOn: {color: C.bg, fontWeight: '700'},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  // The bars at the foot of the app float OVER the page now, so a list has to
  // end above them or its last row is permanently behind one. See src/layout.ts.
  list: {paddingBottom: BOTTOM_INSET},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: S.gutter,
    paddingVertical: 7,
    gap: 13,
  },
  rowText: {flex: 1, minWidth: 0},
  rowTitle: {...T.rowTitle, color: C.text, fontSize: 16},
  rowTitlePlaying: {color: C.accent},
  metaLine: {flexDirection: 'row', alignItems: 'center', marginTop: 3},
  pin: {marginRight: 5, transform: [{rotate: '45deg'}]},
  rowSub: {...T.sub, color: C.sub, flex: 1},
  empty: {
    color: C.faint,
    textAlign: 'center',
    paddingVertical: 40,
    fontSize: 13,
  },
  scrim: {
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
});
