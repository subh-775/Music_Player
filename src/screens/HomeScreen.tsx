import React, {useCallback, useEffect, useState} from 'react';
import {
  FlatList,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {ArrowDownToLine, Heart, ListMusic, Menu} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {getHome, waitForBackend, type HomeItem, type HomeRow, type Track} from '../backend';
import {Greeting} from '../components/Greeting';
import {useRecentlyPlayed} from '../recentlyPlayed';
import {getBestArtworkUrl, cleanText, upgradeArtwork} from '../tracks';
import {createStore, asArray, useStoreValue} from '../storage';
import {usePlaylists} from '../playlists';
import {useLikes} from '../store';
import {useUpdateAvailable} from '../update';

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
export type QuickDest = {kind: 'liked'} | {kind: 'downloads'} | {kind: 'playlist'; id: string};

type Props = {
  onPickTrack: (item: HomeItem) => void;
  onPlayTrack: (track: Track, context: Track[]) => void;
  onOpenMenu: () => void;
  onOpenQuick: (dest: QuickDest) => void;
  /** Home has something to show — the app lifts its splash on this. */
  onReady?: () => void;
};

export function HomeScreen({
  onPickTrack,
  onPlayTrack,
  onOpenMenu,
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
  const phase: 'boot' | 'ready' | 'error' =
    rows.length ? 'ready' : error ? 'error' : 'boot';

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
    <ScrollView
      contentContainerStyle={styles.scroll}
      showsVerticalScrollIndicator={false}
      overScrollMode="never"
      bounces={false}
>
      <View style={styles.header}>
        <Greeting />
        <TouchableOpacity onPress={onOpenMenu} hitSlop={14} style={styles.gear}>
          <Menu size={25} color={C.text} strokeWidth={2.4} />
          {/* A waiting update has to stay findable after the popup is
              dismissed — this is the only thing that says so. */}
          {updateWaiting && <View style={styles.dot} />}
        </TouchableOpacity>
      </View>

      {/* Quick access. The two things everyone opens most (Liked, Downloaded)
          plus the newest playlists, one tap from the top of Home instead of a
          trip through the Library tab. Two columns, so four fit above the fold
          without pushing the content rows off screen. */}
      <View style={styles.quickGrid}>
        <QuickTile
          label="Liked Songs"
          sub={`${likes.length} song${likes.length === 1 ? '' : 's'}`}
          Icon={Heart}
          onPress={() => onOpenQuick({kind: 'liked'})}
        />
        <QuickTile
          label="Downloaded"
          sub="Offline"
          Icon={ArrowDownToLine}
          onPress={() => onOpenQuick({kind: 'downloads'})}
        />
        {playlists.slice(0, 4).map(p => (
          <QuickTile
            key={p.id}
            label={p.name}
            sub={`${p.tracks?.length ?? 0} song${
              (p.tracks?.length ?? 0) === 1 ? '' : 's'
            }`}
            image={p.image}
            Icon={ListMusic}
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
            keyExtractor={(t, i) => `${t.title}-${i}`}
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
  );
}

function QuickTile({
  label,
  sub,
  image,
  Icon,
  onPress,
}: {
  label: string;
  sub?: string;
  image?: string;
  Icon: typeof Heart;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.quick} activeOpacity={0.7} onPress={onPress}>
      <View style={styles.quickArt}>
        {image ? (
          <Image source={{uri: upgradeArtwork(image)}} style={styles.quickImg} />
        ) : (
          <Icon size={20} color={C.text} strokeWidth={2.2} />
        )}
      </View>
      <View style={styles.quickText}>
        <Text style={styles.quickLabel} numberOfLines={1}>
          {label}
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
        keyExtractor={(_, i) => String(i)}
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
          <Image source={{uri: upgradeArtwork(item.image)}} style={styles.art} />
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
  quickArt: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.surface,
  },
  quickImg: {width: 56, height: 56},
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
