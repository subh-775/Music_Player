/**
 * "Add to playlist" — the sheet behind the ⊕ in the player and the ⋮ on a row.
 *
 * Creating a playlist from here adds the song to it immediately, because
 * that's the only reason you'd be creating one at this moment.
 */
import React, {useCallback, useState} from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {Check, Plus} from 'lucide-react-native';
import {C, S, T} from '../theme';
import type {Track} from '../backend';
import {cleanText, getTrackId} from '../tracks';
import {addTrackToPlaylist, createPlaylist, usePlaylists} from '../playlists';
import {CollectionArt} from './CollectionArt';
import {playlistToCollection} from '../collections';
import {toast} from '../toast';
import {Sheet} from './Sheet';

export function AddToPlaylistSheet({
  track,
  onClose,
}: {
  track: Track | null;
  onClose: () => void;
}) {
  const playlists = usePlaylists();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const add = useCallback(
    (id: string, playlistName: string) => {
      if (!track) {
        return;
      }
      const added = addTrackToPlaylist(id, track);
      toast(added ? `Added to ${playlistName}` : `Already in ${playlistName}`);
      onClose();
    },
    [track, onClose],
  );

  const createAndAdd = useCallback(() => {
    const pl = createPlaylist(name);
    setCreating(false);
    setName('');
    if (pl) {
      add(pl.id, pl.name);
    }
  }, [name, add]);

  return (
    <Sheet open={!!track} onClose={onClose} style={styles.sheet}>
      <Text style={styles.title} numberOfLines={1}>
        Add "{cleanText(track?.title)}" to
      </Text>

      {creating ? (
        <View style={styles.newRow}>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Playlist name"
            placeholderTextColor={C.faint}
            style={styles.input}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={createAndAdd}
          />
          <TouchableOpacity
            onPress={createAndAdd}
            disabled={!name.trim()}
            style={styles.newBtn}>
            <Check size={22} color={name.trim() ? C.accent : C.faint} />
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          style={styles.row}
          activeOpacity={0.7}
          onPress={() => setCreating(true)}>
          <View style={styles.plusTile}>
            <Plus size={22} color={C.text} />
          </View>
          <Text style={styles.rowTitle}>New playlist</Text>
        </TouchableOpacity>
      )}

      <FlatList
        data={playlists}
        keyExtractor={p => p.id}
        style={styles.list}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          creating ? null : (
            <Text style={styles.empty}>You haven't made a playlist yet.</Text>
          )
        }
        renderItem={({item}) => {
          const has = track
            ? (item.tracks || []).some(x => getTrackId(x) === getTrackId(track))
            : false;
          return (
            <TouchableOpacity
              style={styles.row}
              activeOpacity={0.7}
              onPress={() => add(item.id, item.name)}>
              <CollectionArt
                collection={playlistToCollection(item)}
                size={46}
              />
              <View style={styles.rowText}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.rowSub}>
                  {item.tracks.length} song
                  {item.tracks.length === 1 ? '' : 's'}
                </Text>
              </View>
              {has && <Check size={19} color={C.accent} />}
            </TouchableOpacity>
          );
        }}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // Scrim, handle, rounded top and the slide all live in <Sheet> now.
  sheet: {maxHeight: '70%'},
  title: {
    ...T.rowTitle,
    color: C.text,
    fontSize: 15,
    paddingHorizontal: S.gutter,
    paddingTop: 14,
    paddingBottom: 8,
  },
  list: {flexGrow: 0},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    paddingHorizontal: S.gutter,
    paddingVertical: 9,
  },
  plusTile: {
    width: 46,
    height: 46,
    borderRadius: 4,
    backgroundColor: C.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: {flex: 1, minWidth: 0},
  rowTitle: {...T.body, color: C.text, flex: 1},
  rowSub: {...T.sub, color: C.sub, marginTop: 2},
  newRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: S.gutter,
    paddingVertical: 10,
  },
  input: {
    flex: 1,
    color: C.text,
    fontSize: 15,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    paddingVertical: 7,
  },
  newBtn: {padding: 6},
  empty: {
    color: C.faint,
    fontSize: 13,
    paddingHorizontal: S.gutter,
    paddingVertical: 20,
  },
});
