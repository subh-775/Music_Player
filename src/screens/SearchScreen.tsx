/**
 * Search.
 *
 * Three states, in the order you meet them:
 *   empty field  → recent searches
 *   typing       → suggestions (debounced, cheap, JioSaavn-only server-side)
 *   submitted    → full cross-source results, final as soon as they land
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
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {Clock, Search as SearchIcon, X} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {
  getGenres,
  getSuggestions,
  search,
  searchArtists,
  waitForBackend,
  type ArtistCard,
  type HomeItem,
  type Suggestion,
  type Track,
} from '../backend';
import {useStats} from '../stats';
import {normalizeTracks} from '../tracks';
import {TrackRow} from '../components/TrackRow';
import {forgetSearch, rememberSearch, useSearchHistory} from '../searchHistory';

/** A public Spotify playlist/album link (or spotify: URI). */
export function isSpotifyUrl(text: string): boolean {
  const s = (text || '').trim();
  return (
    /open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(playlist|album)\//i.test(s) ||
    /^spotify:(playlist|album):/i.test(s)
  );
}

const DEBOUNCE_MS = 180;

/** Browse tiles are colour-blocked, like Spotify's. A fixed rotation keeps a
 *  given tile the same colour across launches — a random one per render made
 *  the grid flicker on every re-render. */
const TILE_COLORS = [
  '#1E3264',
  '#E8115B',
  '#148A08',
  '#8D67AB',
  '#B95D06',
  '#0D73EC',
  '#503750',
  '#477D95',
  '#777777',
  '#E13300',
];
const tileColor = (i: number) => TILE_COLORS[i % TILE_COLORS.length];

export function SearchScreen({
  visible,
  onPickTrack,
  onImportSpotify,
  onMenu,
  onOpenArtist,
  onOpenBrowse,
}: {
  /** Whether the Search tab is the one on screen. The tab stays MOUNTED when
   *  you leave it (that's what keeps it instant to come back to), so leaving is
   *  the only signal there is that the search is over. */
  visible: boolean;
  onPickTrack: (track: Track, context: Track[]) => void;
  onImportSpotify: (url: string) => void;
  onMenu: (track: Track) => void;
  onOpenArtist?: (name: string) => void;
  /** A genre tile — resolved and opened by the app, same as a Home card. */
  onOpenBrowse: (item: HomeItem) => void;
}) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [results, setResults] = useState<Track[]>([]);
  const [artists, setArtists] = useState<ArtistCard[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [focused, setFocused] = useState(false);
  const [genres, setGenres] = useState<HomeItem[]>([]);
  const history = useSearchHistory();
  const {topArtists} = useStats();

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
    // Artists ride alongside the song search — like the WebView build, a
    // query answers with both. Best-effort; a miss just means no strip.
    searchArtists(text, 8)
      .then(list => {
        if (ticket === latest.current) {
          setArtists(list);
        }
      })
      .catch(() => {});
    try {
      const found = normalizeTracks(await search(text, 25));
      if (ticket !== latest.current) {
        return;
      }
      setResults(found);
      // A pasted playlist/album URL is a destination, not a query — putting it
      // in Recent searches leaves an unreadable link in the list.
      if (!isSpotifyUrl(text)) {
        rememberSearch(text);
      }

      // No enrichment pass here any more.
      //
      // It used to fire a SECOND network round trip per search (iTunes and
      // MusicBrainz, for up to 25 tracks) and then rewrite the whole result
      // list, re-rendering every row and re-fetching any artwork it changed —
      // all to fill blanks in fields the source had usually already given us.
      // The visible cost was a list that shuffled and reloaded a moment after
      // it appeared; the invisible one was data spent on every search.
      //
      // The trade is real and deliberate: album, genre and release-date blanks
      // now stay blank, and covers are whatever the source gave. Titles and
      // artists are already cleaned locally (normalizeTracks), and the artwork
      // resolution that actually mattered lives in the backend's own merge —
      // the enrichment pass was the same iTunes matching that put "Phir Se Ud
      // Chala" artwork on a different song from the same album.
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

  /**
   * Leaving the tab ends the search.
   *
   * The tab is kept mounted so returning to it is instant, but that also meant
   * a query typed once stayed on screen forever: play a song, go to Library,
   * come back — and the old result list was still there instead of the artists
   * and genres this screen is supposed to open on. Clearing here puts it back
   * in its idle state without giving up the mounted-tab speed.
   *
   * `latest` is bumped so a search still in flight can't land afterwards and
   * repopulate the list we just cleared.
   */
  useEffect(() => {
    if (visible) {
      return;
    }
    latest.current++;
    setQuery('');
    setResults([]);
    setArtists([]);
    setSuggestions([]);
    setError('');
    setBusy(false);
    setFocused(false);
  }, [visible]);

  // Browse tiles load once, lazily — nobody needs them until the field is idle,
  // and they're cached server-side for 6h anyway.
  useEffect(() => {
    // Wait for the engine first: this mounts during cold start, and firing at
    // t=0 just burns the one attempt on a backend that isn't listening yet.
    waitForBackend()
      .then(ok => (ok ? getGenres() : []))
      .then(setGenres)
      .catch(() => {
        // Browsing is a bonus; searching still works without it.
      });
  }, []);

  const spotify = isSpotifyUrl(query);
  const idle = !query.trim() && !results.length;
  const showSuggestions = !!suggestions.length && !busy;
  /**
   * Recent searches, whenever the field has focus and there is nothing more
   * specific to show.
   *
   * This used to also require an EMPTY field — which is why tapping the search
   * bar after a search showed nothing: the query you just ran was still in it,
   * so the condition was false and the old results stayed put. Tapping the
   * field means "I'm about to search for something else", and the recent list
   * is the answer to that. Typing two characters brings suggestions in over the
   * top of it, so the history is never in the way.
   */
  const showHistory =
    focused && !busy && !spotify && !showSuggestions && history.length > 0;
  // Whenever there's nothing else to show. Focusing with no history to offer
  // would otherwise leave a blank screen under the keyboard.
  const showBrowse = idle && !busy && !spotify && !showHistory;

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
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
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
                <Image
                  source={{uri: item.artwork_url}}
                  style={styles.suggestionArt}
                />
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

      {showBrowse && (
        <ScrollView
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          overScrollMode="never">
          {topArtists.length > 0 && onOpenArtist && (
            <>
              <Text style={styles.section}>Your artists</Text>
              <FlatList
                horizontal
                data={topArtists.slice(0, 12)}
                keyExtractor={a => a.name}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.artistStrip}
                renderItem={({item}) => (
                  <TouchableOpacity
                    style={styles.artistCard}
                    activeOpacity={0.75}
                    onPress={() => onOpenArtist(item.name)}>
                    {item.image ? (
                      <Image
                        source={{uri: item.image}}
                        style={styles.artistPfp}
                      />
                    ) : (
                      <View style={[styles.artistPfp, styles.artistPfpEmpty]}>
                        <Text style={styles.artistInitial}>
                          {item.name.trim().charAt(0).toUpperCase()}
                        </Text>
                      </View>
                    )}
                    <Text style={styles.artistName} numberOfLines={1}>
                      {item.name}
                    </Text>
                  </TouchableOpacity>
                )}
              />
            </>
          )}

          {genres.length > 0 && (
            <>
              <Text style={styles.section}>Browse all</Text>
              <View style={styles.grid}>
                {genres.map((g, i) => (
                  <TouchableOpacity
                    key={`${g.perma_url || g.name}-${i}`}
                    style={[styles.tile, {backgroundColor: tileColor(i)}]}
                    activeOpacity={0.8}
                    onPress={() => onOpenBrowse(g)}>
                    <Text style={styles.tileText} numberOfLines={2}>
                      {g.name || g.title}
                    </Text>
                    {!!g.image && (
                      <Image source={{uri: g.image}} style={styles.tileArt} />
                    )}
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}
        </ScrollView>
      )}

      {!busy && !showHistory && !showSuggestions && !showBrowse && (
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
          ListHeaderComponent={
            artists.length > 0 && onOpenArtist ? (
              <View>
                <Text style={styles.section}>Artists</Text>
                <FlatList
                  horizontal
                  data={artists}
                  keyExtractor={(a, i) => `${a.name}-${i}`}
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.artistStrip}
                  renderItem={({item}) => (
                    <TouchableOpacity
                      style={styles.artistCard}
                      activeOpacity={0.75}
                      onPress={() => onOpenArtist(item.name)}>
                      {item.image ? (
                        <Image
                          source={{uri: item.image}}
                          style={styles.artistPfp}
                        />
                      ) : (
                        <View style={[styles.artistPfp, styles.artistPfpEmpty]}>
                          <Text style={styles.artistInitial}>
                            {item.name.trim().charAt(0).toUpperCase()}
                          </Text>
                        </View>
                      )}
                      <Text style={styles.artistName} numberOfLines={1}>
                        {item.name}
                      </Text>
                    </TouchableOpacity>
                  )}
                />
                <Text style={styles.section}>Songs</Text>
              </View>
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
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: S.gutter,
    gap: 10,
  },
  tile: {
    flexBasis: '47%',
    flexGrow: 1,
    height: 96,
    borderRadius: 8,
    overflow: 'hidden',
    padding: 12,
  },
  tileText: {color: '#fff', fontSize: 15, fontWeight: '800', maxWidth: '75%'},
  // The cover sits half off the corner, rotated — the Spotify browse-tile look,
  // and it means a square cover never has to be cropped to fit.
  tileArt: {
    position: 'absolute',
    right: -14,
    bottom: -6,
    width: 62,
    height: 62,
    borderRadius: 4,
    transform: [{rotate: '25deg'}],
  },
  artistStrip: {paddingHorizontal: S.gutter, gap: 16, paddingBottom: 6},
  artistCard: {width: 84, alignItems: 'center'},
  artistPfp: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: C.surface,
  },
  artistPfpEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.surfaceHi,
  },
  artistInitial: {color: C.faint, fontSize: 26, fontWeight: '700'},
  artistName: {...T.sub, color: C.text, marginTop: 6, textAlign: 'center'},
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
