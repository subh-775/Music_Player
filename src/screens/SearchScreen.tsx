/**
 * Search.
 *
 * Three states, in the order you meet them:
 *   empty field  → recent searches
 *   typing       → suggestions (debounced, cheap, JioSaavn-only server-side)
 *   submitted    → full cross-source results, then enriched once
 *
 * A Spotify playlist/album link pasted into the field is detected and offered
 * as an import rather than searched for as text.
 */
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
import {Clock, Search as SearchIcon, X} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {
  enrichBatch,
  getSuggestions,
  search,
  type Suggestion,
  type Track,
} from '../backend';
import {applyEnrichment, normalizeTracks, type Enrichment} from '../tracks';
import {TrackRow} from '../components/TrackRow';
import {
  forgetSearch,
  rememberSearch,
  useSearchHistory,
} from '../searchHistory';

/** A public Spotify playlist/album link (or spotify: URI). */
export function isSpotifyUrl(text: string): boolean {
  const s = (text || '').trim();
  return (
    /open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(playlist|album)\//i.test(s) ||
    /^spotify:(playlist|album):/i.test(s)
  );
}

const DEBOUNCE_MS = 180;

export function SearchScreen({
  onPickTrack,
  onImportSpotify,
  onMenu,
}: {
  onPickTrack: (track: Track, context: Track[]) => void;
  onImportSpotify: (url: string) => void;
  onMenu: (track: Track) => void;
}) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [results, setResults] = useState<Track[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const history = useSearchHistory();

  // Guards against a slow response for an old query overwriting a newer one.
  const latest = useRef(0);

  const runSearch = useCallback(async (q: string) => {
    const text = q.trim();
    if (!text) {
      return;
    }
    Keyboard.dismiss();
    setBusy(true);
    setError('');
    setSuggestions([]);
    const ticket = ++latest.current;
    try {
      const found = normalizeTracks(await search(text, 25));
      if (ticket !== latest.current) {
        return;
      }
      setResults(found);
      rememberSearch(text);

      // Enrich AFTER render, once, so results appear instantly and clean
      // metadata fills in a moment later. applyEnrichment only fills blanks —
      // it never overwrites what the source already said.
      if (found.length) {
        enrichBatch(found)
          .then(list => {
            if (ticket !== latest.current || !Array.isArray(list)) {
              return;
            }
            setResults(prev =>
              prev.map((t, i) =>
                list[i] && !t._enriched
                  ? applyEnrichment(t, list[i] as Enrichment)
                  : t,
              ),
            );
          })
          .catch(() => {
            // Enrichment is best-effort; the results are already usable.
          });
      }
    } catch (e) {
      if (ticket === latest.current) {
        setError(e instanceof Error ? e.message : String(e));
        setResults([]);
      }
    } finally {
      if (ticket === latest.current) {
        setBusy(false);
      }
    }
  }, []);

  // Debounced suggestions while typing.
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2 || isSpotifyUrl(text)) {
      setSuggestions([]);
      return;
    }
    const id = setTimeout(async () => {
      try {
        const list = await getSuggestions(text);
        // Only apply if the field still holds what we asked about.
        setSuggestions(prev => (query.trim() === text ? list : prev));
      } catch {
        // Suggestions are a convenience — a failure must stay silent.
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  const spotify = isSpotifyUrl(query);
  const showHistory = !query.trim() && history.length > 0;
  const showSuggestions = !!suggestions.length && !busy;

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Search</Text>

      <View style={styles.field}>
        <SearchIcon size={20} color={C.bg} strokeWidth={2.4} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="What do you want to play?"
          placeholderTextColor="#6b6b6b"
          style={styles.input}
          returnKeyType="search"
          autoCorrect={false}
          onSubmitEditing={() => runSearch(query)}
        />
        {!!query && (
          <TouchableOpacity onPress={() => setQuery('')} hitSlop={10}>
            <X size={19} color={C.bg} />
          </TouchableOpacity>
        )}
      </View>

      {spotify && (
        <TouchableOpacity
          style={styles.spotify}
          activeOpacity={0.8}
          onPress={() => onImportSpotify(query.trim())}>
          <Text style={styles.spotifyTitle}>Import from Spotify</Text>
          <Text style={styles.spotifySub} numberOfLines={1}>
            We'll find each song across your sources and save it as a playlist.
          </Text>
        </TouchableOpacity>
      )}

      {busy && (
        <View style={styles.center}>
          <ActivityIndicator color={C.accent} />
        </View>
      )}

      {!!error && !busy && <Text style={styles.error}>{error}</Text>}

      {showHistory && (
        <FlatList
          data={history}
          keyExtractor={q => q}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            <Text style={styles.section}>Recent searches</Text>
          }
          renderItem={({item}) => (
            <TouchableOpacity
              style={styles.historyRow}
              activeOpacity={0.7}
              onPress={() => {
                setQuery(item);
                runSearch(item);
              }}>
              <Clock size={20} color={C.sub} />
              <Text style={styles.historyText} numberOfLines={1}>
                {item}
              </Text>
              <TouchableOpacity
                onPress={() => forgetSearch(item)}
                hitSlop={12}
                style={styles.historyX}>
                <X size={19} color={C.sub} />
              </TouchableOpacity>
            </TouchableOpacity>
          )}
        />
      )}

      {showSuggestions && (
        <FlatList
          data={suggestions}
          keyExtractor={(s, i) => `${s.title}-${s.artist}-${i}`}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={<Text style={styles.section}>Recommended</Text>}
          renderItem={({item}) => (
            <TouchableOpacity
              style={styles.suggestion}
              activeOpacity={0.7}
              onPress={() => {
                const q = `${item.title} ${item.artist}`.trim();
                setQuery(q);
                runSearch(q);
              }}>
              {item.artwork_url ? (
                <Image source={{uri: item.artwork_url}} style={styles.suggestionArt} />
              ) : (
                <View style={[styles.suggestionArt, styles.suggestionArtEmpty]}>
                  <SearchIcon size={16} color={C.faint} />
                </View>
              )}
              <View style={styles.suggestionText}>
                <Text style={styles.suggestionTitle} numberOfLines={1}>
                  {item.title}
                </Text>
                {!!item.artist && (
                  <Text style={styles.suggestionSub} numberOfLines={1}>
                    {item.artist}
                  </Text>
                )}
              </View>
            </TouchableOpacity>
          )}
        />
      )}

      {!busy && !showHistory && !showSuggestions && (
        <FlatList
          data={results}
          keyExtractor={(t, i) => `${t.title}-${t.artist}-${i}`}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            query.trim() && !error ? (
              <Text style={styles.empty}>No songs matched that.</Text>
            ) : null
          }
          renderItem={({item}) => (
            <TrackRow
              track={item}
              onPress={() => onPickTrack(item, results)}
              onMenu={() => onMenu(item)}
            />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1, backgroundColor: C.bg},
  title: {
    ...T.screenTitle,
    color: C.text,
    paddingHorizontal: S.gutter,
    paddingTop: 14,
    paddingBottom: 12,
  },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: S.gutter,
    paddingHorizontal: 14,
    height: 46,
    borderRadius: 6,
    backgroundColor: '#fff',
  },
  input: {flex: 1, color: '#000', fontSize: 15, fontWeight: '600', padding: 0},
  spotify: {
    marginHorizontal: S.gutter,
    marginTop: 12,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface,
  },
  spotifyTitle: {...T.body, color: C.text},
  spotifySub: {...T.sub, color: C.sub, marginTop: 4},
  center: {paddingVertical: 40, alignItems: 'center'},
  error: {
    color: C.danger,
    paddingHorizontal: S.gutter,
    paddingVertical: 20,
    fontSize: 13,
  },
  list: {paddingTop: 8, paddingBottom: 16},
  section: {
    ...T.rowTitle,
    color: C.text,
    fontSize: 16,
    paddingHorizontal: S.gutter,
    paddingTop: 8,
    paddingBottom: 6,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: S.gutter,
    paddingVertical: 13,
  },
  historyText: {...T.body, color: C.text, flex: 1, fontWeight: '500'},
  historyX: {padding: 2},
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: S.gutter,
    paddingVertical: 10,
  },
  suggestionArt: {
    width: 44,
    height: 44,
    borderRadius: 4,
    backgroundColor: C.surface,
  },
  suggestionArtEmpty: {
    backgroundColor: C.surfaceHi,
    alignItems: 'center',
    justifyContent: 'center',
  },
  suggestionText: {flex: 1, minWidth: 0},
  suggestionTitle: {...T.body, color: C.text},
  suggestionSub: {...T.sub, color: C.sub, marginTop: 2},
  empty: {
    color: C.faint,
    textAlign: 'center',
    paddingVertical: 40,
    fontSize: 13,
  },
});
