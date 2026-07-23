import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Keyboard,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {C, S, T} from '../theme';
import {formatDuration, search, type Track} from '../backend';

type Props = {onPickTrack: (t: Track) => void};

/** Brand tint per source, so where a result came from reads at a glance. */
const SOURCE_TINT: Record<string, string> = {
  jiosaavn: '#2bd17e',
  soundcloud: '#ff7733',
  youtube: '#ff4444',
  youtube_music: '#ff4444',
};

export function SearchScreen({onPickTrack}: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Track[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);
  // Guards against a slow earlier request landing after a newer one.
  const seq = useRef(0);

  const run = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) {
      setResults([]);
      setSearched(false);
      return;
    }
    const mine = ++seq.current;
    setBusy(true);
    setError('');
    try {
      const hits = await search(trimmed);
      if (mine === seq.current) {
        setResults(hits);
        setSearched(true);
      }
    } catch (e) {
      if (mine === seq.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (mine === seq.current) {
        setBusy(false);
      }
    }
  }, []);

  // Debounce: search 450ms after typing stops, so we don't fire per keystroke.
  useEffect(() => {
    const t = setTimeout(() => run(query), 450);
    return () => clearTimeout(t);
  }, [query, run]);

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Search</Text>

      <View style={styles.fieldWrap}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Songs, artists, albums"
          placeholderTextColor={C.faint}
          style={styles.field}
          returnKeyType="search"
          autoCorrect={false}
          onSubmitEditing={() => {
            Keyboard.dismiss();
            run(query);
          }}
        />
        {!!query && (
          <TouchableOpacity onPress={() => setQuery('')} style={styles.clear}>
            <Text style={styles.clearText}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {busy && (
        <View style={styles.busy}>
          <ActivityIndicator color={C.accent} />
        </View>
      )}

      {!!error && <Text style={styles.errText}>{error}</Text>}

      {!busy && searched && results.length === 0 && !error && (
        <Text style={styles.empty}>Nothing found for “{query.trim()}”.</Text>
      )}

      <FlatList
        data={results}
        keyExtractor={(t, i) => `${t.title}-${i}`}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.list}
        renderItem={({item}) => (
          <TrackRow track={item} onPress={() => onPickTrack(item)} />
        )}
      />
    </View>
  );
}

function TrackRow({track, onPress}: {track: Track; onPress: () => void}) {
  const source = track.playable_source || track.primary_source || '';
  const tint = SOURCE_TINT[source] || C.faint;
  const dur = formatDuration(track.duration_ms);
  return (
    <TouchableOpacity style={styles.row} activeOpacity={0.65} onPress={onPress}>
      {track.artwork_url ? (
        <Image source={{uri: track.artwork_url}} style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, styles.thumbFallback]} />
      )}
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {track.title}
        </Text>
        <View style={styles.metaLine}>
          {!!source && <View style={[styles.dot, {backgroundColor: tint}]} />}
          <Text style={styles.rowSub} numberOfLines={1}>
            {track.artist}
            {dur ? `  ·  ${dur}` : ''}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1},
  title: {
    ...T.screenTitle,
    color: C.text,
    paddingHorizontal: S.gutter,
    paddingTop: 8,
  },
  fieldWrap: {
    marginHorizontal: S.gutter,
    marginTop: 14,
    backgroundColor: C.surface,
    borderRadius: S.radius,
    borderWidth: 1,
    borderColor: C.border,
    flexDirection: 'row',
    alignItems: 'center',
  },
  field: {
    flex: 1,
    color: C.text,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  clear: {paddingHorizontal: 14, paddingVertical: 12},
  clearText: {color: C.faint, fontSize: 15},
  busy: {paddingTop: 22},
  errText: {
    color: C.danger,
    fontSize: 13,
    paddingHorizontal: S.gutter,
    paddingTop: 16,
  },
  empty: {
    color: C.sub,
    fontSize: 13.5,
    paddingHorizontal: S.gutter,
    paddingTop: 20,
  },
  list: {paddingTop: 10, paddingBottom: 24},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: S.gutter,
    paddingVertical: 8,
    gap: 12,
  },
  thumb: {width: 52, height: 52, borderRadius: 6, backgroundColor: C.surface},
  thumbFallback: {backgroundColor: C.surfaceHi},
  rowText: {flex: 1, minWidth: 0},
  rowTitle: {...T.body, color: C.text},
  metaLine: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3},
  dot: {width: 6, height: 6, borderRadius: 3},
  rowSub: {...T.sub, color: C.sub, flex: 1},
});
