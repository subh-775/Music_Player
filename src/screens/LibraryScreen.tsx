/**
 * Your Library — the same shape as the Fix-Spotify app: Liked Songs and
 * Downloaded are real, openable lists pinned at the top, with filter chips
 * above them, and Settings reachable from the header.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  ArrowDownToLine,
  Heart,
  Settings as SettingsIcon,
} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {getLocalLibrary, type Track} from '../backend';
import {useStore} from '../store';

export type OpenList = {title: string; tracks: Track[]};

const FILTERS = [
  {id: 'all', label: 'All'},
  {id: 'liked', label: 'Liked'},
  {id: 'offline', label: 'Downloaded'},
] as const;
type Filter = (typeof FILTERS)[number]['id'];

export function LibraryScreen({
  onOpenList,
  onOpenSettings,
}: {
  onOpenList: (list: OpenList) => void;
  onOpenSettings: () => void;
}) {
  const {likes} = useStore();
  const [offline, setOffline] = useState<Track[]>([]);
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async () => {
    try {
      const lib = await getLocalLibrary();
      setOffline(lib.tracks);
      setDir(lib.download_dir);
    } catch {
      setOffline([]);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rows = [
    {
      id: 'liked' as const,
      title: 'Liked Songs',
      subtitle: `Playlist · ${likes.length} ${
        likes.length === 1 ? 'song' : 'songs'
      }`,
      Icon: Heart,
      tint: '#5b3df5',
      tracks: likes,
    },
    {
      id: 'offline' as const,
      title: 'Downloaded',
      subtitle: `Offline · ${offline.length} ${
        offline.length === 1 ? 'song' : 'songs'
      }`,
      Icon: ArrowDownToLine,
      tint: '#1db954',
      tracks: offline,
    },
  ].filter(r => filter === 'all' || filter === r.id);

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.title}>Your Library</Text>
        <TouchableOpacity onPress={onOpenSettings} hitSlop={12}>
          <SettingsIcon size={22} color={C.sub} strokeWidth={2} />
        </TouchableOpacity>
      </View>

      <View style={styles.chips}>
        {FILTERS.map(f => (
          <TouchableOpacity
            key={f.id}
            onPress={() => setFilter(f.id)}
            activeOpacity={0.75}
            style={[styles.chip, filter === f.id && styles.chipOn]}>
            <Text
              style={[styles.chipText, filter === f.id && styles.chipTextOn]}>
              {f.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {busy ? (
        <View style={styles.center}>
          <ActivityIndicator color={C.accent} />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={r => r.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={load}
              tintColor={C.accent}
              colors={[C.accent]}
            />
          }
          renderItem={({item}) => (
            <TouchableOpacity
              style={styles.row}
              activeOpacity={0.7}
              onPress={() =>
                onOpenList({title: item.title, tracks: item.tracks})
              }>
              <View style={[styles.tile, {backgroundColor: item.tint}]}>
                <item.Icon size={24} color="#fff" fill="#fff" strokeWidth={1} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>{item.title}</Text>
                <Text style={styles.rowSub}>{item.subtitle}</Text>
              </View>
            </TouchableOpacity>
          )}
          ListFooterComponent={
            !!dir && filter !== 'liked' ? (
              <Text style={styles.dir}>Downloads folder: {dir}</Text>
            ) : null
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: S.gutter,
    paddingTop: 8,
  },
  title: {...T.screenTitle, color: C.text},
  chips: {flexDirection: 'row', gap: 8, paddingHorizontal: S.gutter, marginTop: 14},
  chip: {
    paddingHorizontal: 13,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: C.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
  },
  chipOn: {backgroundColor: C.accent, borderColor: C.accent},
  chipText: {...T.sub, color: C.sub},
  chipTextOn: {color: C.bg, fontWeight: '700'},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  list: {paddingTop: 14, paddingBottom: 24},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: S.gutter,
    paddingVertical: 8,
    gap: 13,
  },
  tile: {
    width: 54,
    height: 54,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: {flex: 1, minWidth: 0},
  rowTitle: {...T.body, color: C.text, fontSize: 15.5},
  rowSub: {...T.sub, color: C.sub, marginTop: 3},
  dir: {
    color: C.faint,
    fontSize: 11,
    paddingHorizontal: S.gutter,
    paddingTop: 18,
  },
});
