import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  FlatList,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {Gesture, GestureDetector} from 'react-native-gesture-handler';
import {runOnJS} from 'react-native-reanimated';
import {Menu} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {
  getHome,
  waitForBackend,
  type HomeItem,
  type HomeRow,
  type Track,
} from '../backend';
import {Greeting} from '../components/Greeting';
import {useRecentlyPlayed} from '../recentlyPlayed';
import {
  getBestArtworkUrl,
  cleanText,
  getTrackId,
  upgradeArtwork,
} from '../tracks';
import {createStore, asArray, useStoreValue} from '../storage';
import {usePlaylists} from '../playlists';
import {useLikes} from '../store';
import {CollectionArt} from '../components/CollectionArt';
import {
  downloadsCollection,
  likedCollection,
  playlistToCollection,
  type Collection,
} from '../collections';
import {useUpdateAvailable} from '../update';
import {DRAWER_GRAB, DRAWER_W, drawerX, shouldOpen} from '../drawer';

/**
 * Last Home rows, persisted. Showing these instantly on the next launch is
 * what replaces the "Starting the music engine…" wait with actual content —
 * the backend still warms up behind them and the fresh rows swap in when
 * ready, but the user never stares at a spinner.
 */
const homeCache = createStore<HomeRow[]>('mp.homeRows.v1', [], raw =>
  asArray<HomeRow>(raw).filter(r => r && Array.isArray(r.items)),
);

/** What a quick-access tile points at. Home doesn't own the tracklists — the
 *  app resolves the id, the same way it resolves a library row. */
export type QuickDest =
  | {kind: 'liked'}
  | {kind: 'downloads'}
  | {kind: 'playlist'; id: string};

type Props = {
  onPickTrack: (item: HomeItem) => void;
  onPlayTrack: (track: Track, context: Track[]) => void;
  onOpenMenu: () => void;
  /** A drawer pull has started — mount the panel NOW so it can be dragged. */
  onBeginDrag: () => void;
  /** The finger lifted: settle open or closed, carrying its speed. */
  onEndDrag: (open: boolean, velocity: number) => void;
  onOpenQuick: (dest: QuickDest) => void;
  /** Home has something to show — the app lifts its splash on this. */
  onReady?: () => void;
};

export function HomeScreen({
  onPickTrack,
  onPlayTrack,
  onOpenMenu,
  onBeginDrag,
  onEndDrag,
  onOpenQuick,
  onReady,
}: Props) {
  const recent = useRecentlyPlayed();
  const playlists = usePlaylists();
  const likes = useLikes();
  const updateWaiting = useUpdateAvailable();
  // Subscribed, so cached rows appear the moment disk hydration finishes even
  // if that lands after first render.
  const cachedRows = useStoreValue(homeCache);
  const [fresh, setFresh] = useState<HomeRow[] | null>(null);
  const [error, setError] = useState('');

  const rows = fresh ?? cachedRows;
  const phase: 'boot' | 'ready' | 'error' = rows.length
    ? 'ready'
    : error
    ? 'error'
    : 'boot';

  /**
   * Drag right anywhere on Home to pull the drawer in, with the panel following
   * the finger the whole way — Gmail / Twitter / ChatGPT behaviour.
   *
   * Recognised NATIVELY. As a PanResponder this lost the same race TrackRow's
   * swipe did: the JS predicate was evaluated after the native scroller had
   * already claimed a fast flick, and its `dx > |dy| * 2` ratio failed on the
   * large first delta a fast flick delivers. activeOffsetX/failOffsetY are
   * evaluated on the raw touch stream, so speed stops mattering.
   *
   * failOffsetY is what leaves vertical page scrolling and the horizontal
   * "Recently played" rows alone.
   *
   * Every move writes straight to the shared drawerX on the UI thread — JS is
   * touched only twice per gesture, to mount the panel and to settle it.
   */
  const beginRef = useRef(onBeginDrag);
  beginRef.current = onBeginDrag;
  const endRef = useRef(onEndDrag);
  endRef.current = onEndDrag;

  const begin = useCallback(() => beginRef.current(), []);
  const end = useCallback(
    (open: boolean, velocity: number) => endRef.current(open, velocity),
    [],
  );

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-1000, DRAWER_GRAB])
        .failOffsetY([-16, 16])
        .onBegin(() => {
          drawerX.value = -DRAWER_W; // start from closed, whatever came before
          runOnJS(begin)();
        })
        .onUpdate(e => {
          drawerX.value = Math.max(
            -DRAWER_W,
            Math.min(0, -DRAWER_W + e.translationX),
          );
        })
        .onEnd(e => {
          runOnJS(end)(
            shouldOpen(e.translationX, e.velocityX),
            Math.abs(e.velocityX) / 1000,
          );
        }),
    [begin, end],
  );

  const load = useCallback(async () => {
    setError('');
    try {
      if (!(await waitForBackend())) {
        throw new Error('The music engine did not start.');
      }
      const data = await getHome();
      if (data.length) {
        setFresh(data);
        homeCache.set(data); // seed the next launch
      }
    } catch (e) {
      // Only surface the error if there's nothing on screen — a failed refresh
      // behind cached rows should stay silent.
      if (!homeCache.get().length) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Tell the app the moment there is real content (or a definite failure) —
  // the splash stays up until then, so Home is never seen mid-load.
  useEffect(() => {
    if (phase !== 'boot') {
      onReady?.();
    }
  }, [phase, onReady]);

  if (phase === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.errText}>{error}</Text>
        <TouchableOpacity style={styles.retry} onPress={() => load()}>
          <Text style={styles.retryText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <GestureDetector gesture={pan}>
      <View style={styles.fill}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          overScrollMode="never"
          bounces={false}>
          {/* Hamburger FIRST: the drawer slides in from the left, so its handle
          belongs on the left — a right-hand button that opens a left-hand panel
          reads backwards, and it's the far corner for a right thumb. */}
          <View style={styles.header}>
            <TouchableOpacity
              onPress={onOpenMenu}
              hitSlop={14}
              style={styles.gear}>
              <Menu size={25} color={C.text} strokeWidth={2.4} />
              {/* A waiting update has to stay findable after the popup is
              dismissed — this is the only thing that says so. */}
              {updateWaiting && (
                <View
                  style={styles.dot}
                  accessibilityLabel="Update available"
                  accessible
                />
              )}
            </TouchableOpacity>
            <View style={styles.headerText}>
              <Greeting />
            </View>
          </View>

          {/* Quick access. The two things everyone opens most (Liked, Downloaded)
          plus the newest playlists, one tap from the top of Home instead of a
          trip through the Library tab. Two columns, so four fit above the fold
          without pushing the content rows off screen. */}
          <View style={styles.quickGrid}>
            <QuickTile
              collection={likedCollection(likes)}
              sub={`${likes.length} song${likes.length === 1 ? '' : 's'}`}
              onPress={() => onOpenQuick({kind: 'liked'})}
            />
            <QuickTile
              collection={downloadsCollection([])}
              sub="Offline"
              onPress={() => onOpenQuick({kind: 'downloads'})}
            />
            {playlists.slice(0, 4).map(p => (
              <QuickTile
                key={p.id}
                collection={playlistToCollection(p)}
                sub={`${p.tracks?.length ?? 0} song${
                  (p.tracks?.length ?? 0) === 1 ? '' : 's'
                }`}
                onPress={() => onOpenQuick({kind: 'playlist', id: p.id})}
              />
            ))}
          </View>

          {recent.length > 0 && (
            <View style={styles.row}>
              <Text style={styles.rowTitle}>Recently played</Text>
              <FlatList
                horizontal
                data={recent}
                keyExtractor={t => getTrackId(t)}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.rowList}
                renderItem={({item}) => (
                  <TouchableOpacity
                    style={styles.card}
                    activeOpacity={0.7}
                    onPress={() => onPlayTrack(item, recent)}>
                    <View style={styles.artWrap}>
                      {getBestArtworkUrl(item) ? (
                        <Image
                          source={{uri: getBestArtworkUrl(item)}}
                          style={styles.art}
                        />
                      ) : (
                        <View style={[styles.art, styles.artFallback]} />
                      )}
                    </View>
                    <Text style={styles.cardTitle} numberOfLines={2}>
                      {cleanText(item.title)}
                    </Text>
                  </TouchableOpacity>
                )}
              />
            </View>
          )}

          {rows.map(row => (
            <Row key={row.title} row={row} onPick={onPickTrack} />
          ))}
          <View style={styles.tail} />
        </ScrollView>
      </View>
    </GestureDetector>
  );
}

/** The artwork square is CollectionArt, the same component the Library rows
 *  use — that's what gives Liked its purple heart tile, Downloads its green
 *  one, and a playlist its cover or 2×2 mosaic. The hand-rolled version here
 *  had none of that, so every tile came up as an empty grey box. */
function QuickTile({
  collection,
  sub,
  onPress,
}: {
  collection: Collection;
  sub?: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={styles.quick}
      activeOpacity={0.7}
      onPress={onPress}>
      <CollectionArt collection={collection} size={56} />
      <View style={styles.quickText}>
        <Text style={styles.quickLabel} numberOfLines={1}>
          {collection.name}
        </Text>
        {!!sub && (
          <Text style={styles.quickSub} numberOfLines={1}>
            {sub}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

function Row({row, onPick}: {row: HomeRow; onPick: (i: HomeItem) => void}) {
  if (!row.items?.length) {
    return null;
  }
  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle}>{row.title}</Text>
      <FlatList
        horizontal
        data={row.items}
        // Stable per card. Index-based keys meant any refresh that shifted the
        // row re-keyed every card after it, remounting each one and throwing
        // away its decoded <Image> — which is the artwork flash on refresh.
        keyExtractor={item =>
          item.perma_url || `${item.type}|${item.title || item.name}`
        }
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rowList}
        renderItem={({item}) => <Card item={item} onPick={onPick} />}
      />
    </View>
  );
}

function Card({item, onPick}: {item: HomeItem; onPick: (i: HomeItem) => void}) {
  const label = item.title || item.name || 'Untitled';
  // Playlists/albums read better as circles-vs-squares? No — keep one shape so
  // a row of mixed types stays visually even; the subtitle says what it is.
  return (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={0.7}
      onPress={() => onPick(item)}>
      <View style={styles.artWrap}>
        {item.image ? (
          <Image
            source={{uri: upgradeArtwork(item.image)}}
            style={styles.art}
          />
        ) : (
          <View style={[styles.art, styles.artFallback]} />
        )}
      </View>
      <Text style={styles.cardTitle} numberOfLines={2}>
        {label}
      </Text>
      {!!item.subtitle && (
        <Text style={styles.cardSub} numberOfLines={1}>
          {item.subtitle}
        </Text>
      )}
    </TouchableOpacity>
  );
}

const CARD = 138;

const styles = StyleSheet.create({
  fill: {flex: 1},
  scroll: {paddingBottom: 24},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: S.gutter,
    paddingTop: 16,
    paddingBottom: 6,
    gap: 12,
  },
  gear: {padding: 2},
  headerText: {flex: 1, minWidth: 0},
  dot: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: C.accent,
    borderWidth: 1.5,
    borderColor: C.bg,
  },
  title: {
    ...T.screenTitle,
    color: C.text,
    paddingHorizontal: S.gutter,
    paddingTop: 8,
    paddingBottom: 4,
  },
  quickGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: S.gutter,
    gap: 8,
    marginTop: 10,
  },
  // Two per line, whatever the screen width — the gap is fixed, so the tile
  // takes half of what's left rather than a hardcoded width.
  quick: {
    flexBasis: '48%',
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    height: 56,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: C.surfaceHi,
  },
  quickText: {flex: 1, minWidth: 0, paddingHorizontal: 10},
  quickLabel: {color: C.text, fontSize: 13.5, fontWeight: '700'},
  quickSub: {color: C.sub, fontSize: 11, marginTop: 2},
  row: {marginTop: 22},
  rowTitle: {
    ...T.rowTitle,
    color: C.text,
    paddingHorizontal: S.gutter,
    marginBottom: 10,
  },
  rowList: {paddingHorizontal: S.gutter, gap: S.gap},
  card: {width: CARD},
  artWrap: {
    borderRadius: S.radius,
    overflow: 'hidden',
    backgroundColor: C.surface,
  },
  art: {width: CARD, height: CARD},
  artFallback: {backgroundColor: C.surfaceHi},
  cardTitle: {...T.body, color: C.text, marginTop: 8, lineHeight: 18},
  cardSub: {...T.sub, color: C.sub, marginTop: 2},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14},
  errText: {
    color: C.danger,
    fontSize: 13.5,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  retry: {
    backgroundColor: C.accent,
    paddingHorizontal: 22,
    paddingVertical: 10,
    borderRadius: 999,
  },
  retryText: {color: C.bg, fontWeight: '700', fontSize: 13},
  tail: {height: 8},
});
