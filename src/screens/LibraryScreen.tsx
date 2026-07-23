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
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {Pin, Plus} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {getLocalLibrary, type Track} from '../backend';
import {useLikes} from '../store';
import {useFollowedArtists} from '../artists';
import {
  collectionSubtitle,
  useLibrary,
  type Collection,
} from '../collections';
import {createPlaylist} from '../playlists';
import {MAX_PINS, isPinned, rowId, sortPinned, togglePin, usePins} from '../pins';
import {CollectionArt, DOWNLOAD_TINT} from '../components/CollectionArt';
import {toast} from '../toast';

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

export function LibraryScreen({onOpen}: {onOpen: (c: Collection) => void}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [downloads, setDownloads] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const likes = useLikes();
  const pins = usePins();
  const artists = useFollowedArtists();
  const library = useLibrary(likes, downloads);

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
      setDownloads(tracks);
    } catch {
      // Offline library unavailable — the rest of the library still works.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDownloads();
  }, [loadDownloads]);

  const rows = useMemo(() => {
    const matches = (c: Collection) => {
      switch (filter) {
        case 'playlists':
          return c.kind === 'userPlaylist' || c.kind === 'sourcePlaylist' || c.kind === 'liked';
        case 'albums':
          return c.kind === 'album';
        case 'artists':
          return c.kind === 'artist';
        default:
          return true;
      }
    };
    return sortPinned(withArtists.filter(matches), pins, idOf);
  }, [withArtists, pins, filter]);

  const onLongPress = useCallback((c: Collection) => {
    // Liked Songs and Downloads are already pinned to the top by construction —
    // pinning them would be a no-op the user couldn't see.
    if (c.kind === 'liked' || c.kind === 'downloads') {
      return;
    }
    const result = togglePin(idOf(c));
    if (result === 'full') {
      toast(`You can pin up to ${MAX_PINS}. Unpin one first.`);
    } else {
      toast(result === 'pinned' ? `Pinned ${c.name}` : `Unpinned ${c.name}`);
    }
  }, []);

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
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {item.name}
                </Text>
                <View style={styles.metaLine}>
                  {isPinned(idOf(item)) && (
                    <Pin
                      size={12}
                      color={DOWNLOAD_TINT}
                      fill={DOWNLOAD_TINT}
                      style={styles.pin}
                    />
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

      <Modal
        visible={creating}
        transparent
        animationType="fade"
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
}

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
  list: {paddingBottom: 12},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: S.gutter,
    paddingVertical: 7,
    gap: 13,
  },
  rowText: {flex: 1, minWidth: 0},
  rowTitle: {...T.rowTitle, color: C.text, fontSize: 16},
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
});
