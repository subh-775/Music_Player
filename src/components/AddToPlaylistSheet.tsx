/**
 * "Saved in" — the sheet behind the + in both players and the ⋮ on a row.
 *
 * It used to add one song to one playlist and close. It toggles now, and stays
 * open: the reason you came here is usually "which of my playlists is this in",
 * and answering that by tapping a row, watching the sheet close, and reopening
 * it to check the next one is not an answer. Three playlists in one visit is
 * one visit.
 *
 * Liked Songs is the first row and it is the SAME toggle as the + button that
 * opened the sheet — one concept, one place to undo it. Letting "liked" and
 * "in Liked Songs" become two different things is the way this feature breaks.
 *
 * Creating a playlist from here adds the song to it immediately, because that's
 * the only reason you'd be creating one at this moment.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  Check,
  CircleCheck,
  CirclePlus,
  Heart,
  Plus,
  Search,
} from 'lucide-react-native';
import {C, S, T} from '../theme';
import type {Track} from '../backend';
import {cleanText} from '../tracks';
import {
  addTrackToPlaylist,
  createPlaylist,
  playlistsContaining,
  removeTrackFromPlaylist,
  usePlaylists,
} from '../playlists';
import {rowId, sortPinned, usePins} from '../pins';
import {PinGlyph} from './PinGlyph';
import {useLike} from '../store';
import {CollectionArt} from './CollectionArt';
import {playlistToCollection} from '../collections';
import {toast} from '../toast';
import Animated, {
  useAnimatedScrollHandler,
  useSharedValue,
} from 'react-native-reanimated';
import {Sheet} from './Sheet';

/** Above this many, finding one by eye is a scroll rather than a glance. */
const FILTER_FROM = 6;

export function AddToPlaylistSheet({
  track,
  onClose,
}: {
  track: Track | null;
  onClose: () => void;
}) {
  const playlists = usePlaylists();
  const pins = usePins();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  /**
   * The track held through the close animation.
   *
   * `track` goes null the instant this is dismissed and <Sheet> keeps the panel
   * on screen while it slides away, so reading the prop directly flashed an
   * empty title for the length of the exit.
   */
  const [shown, setShown] = useState<Track | null>(track);
  const {liked, toggle: toggleLiked} = useLike(track);

  useEffect(() => {
    if (track) {
      setShown(track);
      return;
    }
    // Closed. A half-typed name or a stale filter must NOT still be sitting
    // there the next time this opens — the sheet is no longer torn down between
    // opens, so what used to be reset by unmounting has to be reset here.
    setCreating(false);
    setName('');
    setQuery('');
  }, [track]);

  const memberOf = useMemo(
    () => playlistsContaining(playlists, track),
    [playlists, track],
  );

  // Pinned first, then filtered — so pinning still means "near the top" inside
  // a filtered result rather than only in the unfiltered list.
  const rows = useMemo(() => {
    const sorted = sortPinned(playlists, pins, p => rowId('playlist', p));
    const q = query.trim().toLowerCase();
    return q ? sorted.filter(p => p.name.toLowerCase().includes(q)) : sorted;
  }, [playlists, pins, query]);

  const toggleIn = useCallback(
    (id: string, playlistName: string) => {
      if (!track) {
        return;
      }
      if (memberOf.has(id)) {
        removeTrackFromPlaylist(id, track);
        toast(`Removed from ${playlistName}`);
      } else {
        addTrackToPlaylist(id, track);
        toast(`Added to ${playlistName}`);
      }
    },
    [track, memberOf],
  );

  const createAndAdd = useCallback(() => {
    const pl = createPlaylist(name);
    setCreating(false);
    setName('');
    if (pl && track) {
      addTrackToPlaylist(pl.id, track);
      toast(`Added to ${pl.name}`);
    }
  }, [name, track]);

  const onLikedRow = useCallback(() => {
    toggleLiked();
    toast(liked ? 'Removed from Liked Songs' : 'Added to Liked Songs');
  }, [liked, toggleLiked]);

  // 0 means the list is at its top, which is when a downward pull stops
  // belonging to the list and starts belonging to the sheet.
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler(e => {
    scrollY.value = e.contentOffset.y;
  });

  return (
    <Sheet
      open={!!track}
      onClose={onClose}
      scrollY={scrollY}
      style={styles.sheet}>
      <Text style={styles.title}>Saved in</Text>
      <Text style={styles.subtitle} numberOfLines={1}>
        {cleanText(shown?.title)}
      </Text>

      {/* Liked Songs, above everything including the filter: it is the one
          destination that is always there, and it is the toggle the + itself
          drives. */}
      <TouchableOpacity
        style={styles.row}
        activeOpacity={0.7}
        onPress={onLikedRow}>
        <View style={styles.likedTile}>
          <Heart size={22} color={C.accent} fill={C.accent} />
        </View>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            Liked Songs
          </Text>
        </View>
        <Tick on={liked} />
      </TouchableOpacity>

      {playlists.length > FILTER_FROM && !creating && (
        <View style={styles.findRow}>
          <Search size={16} color={C.faint} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Find playlist"
            placeholderTextColor={C.faint}
            style={styles.find}
            returnKeyType="search"
          />
        </View>
      )}

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

      {/* Animated, so the offset reaches the sheet's gesture on the UI thread.
          A JS onScroll would be a frame or two stale exactly when it matters —
          at the top of a fling, deciding who owns the finger. */}
      <Animated.FlatList
        data={rows}
        onScroll={onScroll}
        scrollEventThrottle={16}
        keyExtractor={p => p.id}
        style={styles.list}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          creating ? null : (
            <Text style={styles.empty}>
              {query.trim()
                ? 'No playlist by that name.'
                : 'You have not made a playlist yet.'}
            </Text>
          )
        }
        renderItem={({item}) => {
          const inPlaylist = memberOf.has(item.id);
          const pinned = pins.includes(rowId('playlist', item));
          return (
            <TouchableOpacity
              style={styles.row}
              activeOpacity={0.7}
              onPress={() => toggleIn(item.id, item.name)}>
              <CollectionArt collection={playlistToCollection(item)} size={46} />
              <View style={styles.rowText}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {item.name}
                </Text>
                <View style={styles.subRow}>
                  {pinned && <PinGlyph size={11} color={C.sub} />}
                  <Text style={styles.rowSub}>
                    {item.tracks.length} song
                    {item.tracks.length === 1 ? '' : 's'}
                  </Text>
                </View>
              </View>
              <Tick on={inPlaylist} />
            </TouchableOpacity>
          );
        }}
      />
    </Sheet>
  );
}

/** The same mark the + button wears, so "in" looks identical everywhere. */
function Tick({on}: {on: boolean}) {
  return on ? (
    <CircleCheck size={26} color={C.bg} fill={C.accent} strokeWidth={2.4} />
  ) : (
    <CirclePlus size={26} color={C.sub} strokeWidth={1.6} />
  );
}

const styles = StyleSheet.create({
  // Scrim, handle, rounded top and the slide all live in <Sheet> now.
  sheet: {maxHeight: '75%'},
  title: {
    ...T.rowTitle,
    color: C.text,
    fontSize: 16,
    paddingHorizontal: S.gutter,
    paddingTop: 14,
  },
  subtitle: {
    ...T.sub,
    color: C.sub,
    paddingHorizontal: S.gutter,
    paddingTop: 2,
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
  likedTile: {
    width: 46,
    height: 46,
    borderRadius: 4,
    backgroundColor: C.surface,
    alignItems: 'center',
    justifyContent: 'center',
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
  subRow: {flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2},
  rowSub: {...T.sub, color: C.sub},
  findRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: S.gutter,
    marginBottom: 4,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: C.surface,
  },
  find: {flex: 1, color: C.text, fontSize: 14.5, paddingVertical: 8},
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
