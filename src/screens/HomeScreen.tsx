import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  FlatList,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {Gesture, GestureDetector} from 'react-native-gesture-handler';
import {runOnJS} from 'react-native-reanimated';
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
import {upgradeArtwork} from '../tracks';
import {createStore, asArray, useStoreValue} from '../storage';
import {MenuMark} from '../components/MenuMark';
import {RecentsGrid} from '../components/RecentsGrid';
import {
  DRAWER_EDGE,
  DRAWER_GRAB,
  DRAWER_W,
  drawerX,
  reserveDrawerEdge,
  shouldOpen,
} from '../drawer';
import {BOTTOM_INSET} from '../layout';

/**
 * Last Home rows, persisted. Showing these instantly on the next launch is
 * what replaces the "Starting the music engine…" wait with actual content —
 * the backend still warms up behind them and the fresh rows swap in when
 * ready, but the user never stares at a spinner.
 *
 * CAPPED, on the way in as well as on the way out. Uncapped, this grew with
 * whatever the backend chose to return — every row, every item, each carrying
 * a full `artwork_urls` map — and the whole blob was JSON.parse'd on the JS
 * thread during every cold start, before the first frame, getting slower as
 * the catalogue behind it got richer. It is a render cache for the top of one
 * screen: it does not need to be the whole payload, and everything below the
 * fold has been replaced by fresh data before anyone can scroll to it.
 *
 * Only what is PERSISTED is trimmed. What is on screen stays whole.
 */
const CACHE_ROWS = 4;
const CACHE_ITEMS_PER_ROW = 12;

const trimForCache = (rows: HomeRow[]): HomeRow[] =>
  rows
    .filter(r => r && Array.isArray(r.items))
    .slice(0, CACHE_ROWS)
    .map(r => ({...r, items: r.items.slice(0, CACHE_ITEMS_PER_ROW)}));

const homeCache = createStore<HomeRow[]>('mp.homeRows.v1', [], raw =>
  trimForCache(asArray<HomeRow>(raw)),
);

type Props = {
  onPickTrack: (item: HomeItem) => void;
  onPlayTrack: (track: Track, context: Track[]) => void;
  onOpenMenu: () => void;
  /** A drawer pull has started — mount the panel NOW so it can be dragged. */
  onBeginDrag: () => void;
  /** The finger lifted: settle open or closed, carrying its speed. */
  onEndDrag: (open: boolean, velocity: number) => void;
  /** Home has something to show — the app lifts its splash on this. */
  onReady?: () => void;
  /** Whether the Home tab is the one on screen. The tab stays mounted when
   *  you leave it, so this is the only signal that you came back — the
   *  greeting takes new colours then. */
  visible: boolean;
};

/**
 * Virtualisation for the OUTER list.
 *
 * Not TrackRow's `listWindowing`: these items are whole carousels, each holding
 * ~10 cards with remote images, so three of them is already more than a screen
 * and twelve would be the entire page mounted at once — which is exactly what
 * the ScrollView this replaces was doing.
 *
 * `removeClippedSubviews` is deliberately NOT set. Virtualisation
 * (windowSize/initialNumToRender) is what actually unmounts the off-screen
 * rows, and it does so in JS where it is predictable; removeClippedSubviews is
 * a separate native detach that has a long history of blanking content inside
 * nested horizontal lists, which is precisely what every row here is.
 */
const HOME_WINDOWING = {
  initialNumToRender: 3,
  maxToRenderPerBatch: 2,
  windowSize: 5,
} as const;

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
export const HomeScreen = React.memo(function HomeScreen({
  onPickTrack,
  onPlayTrack,
  onOpenMenu,
  onBeginDrag,
  onEndDrag,
  onReady,
  visible,
}: Props) {
  const recent = useRecentlyPlayed();
  // Subscribed, so cached rows appear the moment disk hydration finishes even
  // if that lands after first render.
  const cachedRows = useStoreValue(homeCache);
  const [fresh, setFresh] = useState<HomeRow[] | null>(null);
  const [error, setError] = useState('');

  const allRows = fresh ?? cachedRows;
  // Empty rows used to render as null inside the ScrollView. As list DATA they
  // would each cost a cell for nothing, and they throw the windowing counts off.
  const rows = useMemo(() => allRows.filter(r => !!r.items?.length), [allRows]);
  const phase: 'boot' | 'ready' | 'error' = allRows.length
    ? 'ready'
    : error
    ? 'error'
    : 'boot';

  /**
   * Drag right near the left edge to pull the drawer in, with the panel
   * following the finger the whole way — Gmail / Twitter / ChatGPT behaviour.
   *
   * Recognised NATIVELY. As a PanResponder this lost the same race TrackRow's
   * swipe did: the JS predicate ran after the native scroller had already
   * claimed a fast flick, and its `dx > |dy| * 2` ratio failed on the large
   * first delta a fast flick delivers. activeOffsetX/failOffsetY are evaluated
   * on the raw touch stream, so speed stops mattering.
   *
   * ## Why this is attached to the whole screen and not to a strip
   *
   * The previous design put the pan on a transparent 28dp `View` pinned to the
   * left edge, with `pointerEvents="box-only"`. That view took every touch in
   * the band and passed none of them on, so a vertical scroll starting there
   * failed `failOffsetY` and then went nowhere — the list underneath never saw
   * it. That is the "the page won't scroll near the left edge" report.
   *
   * The pan now lives on the screen itself and is armed at the edge by
   * `hitSlop`, which does the same job in the one place where it costs nothing:
   * `{left: 0, width: DRAWER_EDGE}` makes RNGH's `isWithinBounds` treat the
   * handler's activation area as the left DRAWER_EDGE pixels of the view and
   * nothing else (GestureHandler.kt: `right = left + width`). Touches outside
   * the band never reach this handler; touches INSIDE it reach the list too,
   * because there is no longer a view in the way.
   *
   * `failOffsetY` is 6, not 14. While the pan is BEGAN the scroller cannot
   * start, so that number is literally how many pixels of every vertical drag
   * in the band get swallowed before the list gets its touch.
   *
   * One gesture at a time. The list is wrapped as `Gesture.Native()` so RNGH
   * can arbitrate between the two: whichever activates first wins and the
   * other is cancelled. A sideways pull owns the finger until it lets go (the
   * page no longer scrolls under the opening drawer), and a scroll that has
   * started never turns into a drawer. The two used to be declared
   * simultaneous, which is what let one drag do both.
   *
   * The drawer is told it is opening on ACTIVATION (`onStart`), not on
   * touch-down. A touch in the band that becomes a scroll fails this pan and
   * never reaches `onEnd`, so a touch-down `begin` left the (closed) drawer
   * marked open, taking the back button and touches meant for the page.
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

  /** The list's own scrolling, as a gesture this one can be composed with. */
  const listScroll = useMemo(() => Gesture.Native(), []);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({left: 0, width: DRAWER_EDGE})
        .activeOffsetX([-1000, DRAWER_GRAB])
        .failOffsetY([-6, 6])
        .onStart(() => {
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
        homeCache.set(trimForCache(data)); // seed the next launch
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

  // Claiming the left strip back from Android's system back gesture happens in
  // onLayout, below — NOT here. Home mounts while the splash is still up, and
  // the exclusion rect is measured from the decor view's height, which at that
  // point is routinely 0. A zero-height rect excludes nothing, so Android kept
  // the strip and ate the swipe. The view outlives every re-layout; the
  // MEASUREMENT taken from it does not.

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

  /**
   * Everything above the content rows that SCROLLS with them.
   *
   * An element rather than a component: React reconciles it by type, so it
   * re-renders in place instead of remounting — passing an inline arrow as
   * ListHeaderComponent is what tears the Recents grid down and rebuilds it
   * on every parent render.
   *
   * The mark and the greeting are not in here: they are pinned above the list
   * (see the render below), as the title rows of Search and Your Library are.
   */
  const header = (
    <>
      {/* Recents: the last nine songs, as the YouTube Music speed dial. */}
      <RecentsGrid recent={recent} onPlay={onPlayTrack} />
    </>
  );

  return (
    <GestureDetector gesture={pan}>
      <View style={styles.fill} onLayout={() => reserveDrawerEdge()}>
        {/*
        A FlatList, not a ScrollView.

        A ScrollView renders every child immediately and keeps them all
        mounted — and every child here is a horizontal FlatList of cards with
        remote images. The whole of Home, however far down it went, was being
        built and held on the first frame. Virtualised, the rows below the fold
        do not mount their cards until you scroll to them.

        It is wrapped in its own Gesture.Native so the drawer pull can be
        declared simultaneous with it: a scroll that has already begun is not
        cancelled if the pan activates a moment later.
      */}
        {/* Pinned: the mark and the greeting stay put while the page scrolls
            under them, as on Search and Your Library. Mark FIRST: the drawer
            slides in from the left, so its handle belongs on the left. */}
        <View style={styles.header}>
          {/* The mark IS the menu button — see MenuMark. */}
          <MenuMark onPress={onOpenMenu} />
          <View style={styles.headerText}>
            <Greeting visible={visible} />
          </View>
          {/* Balances the mark, so the greeting is centred on the SCREEN
              rather than in the space the mark leaves. */}
          <View style={styles.markSpacer} />
        </View>
        <GestureDetector gesture={listScroll}>
          <FlatList
            data={rows}
            keyExtractor={row => row.title}
            renderItem={({item}) => <Row row={item} onPick={onPickTrack} />}
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
            overScrollMode="never"
            bounces={false}
            ListHeaderComponent={header}
            ListFooterComponent={<View style={styles.tail} />}
            {...HOME_WINDOWING}
          />
        </GestureDetector>
      </View>
    </GestureDetector>
  );
});

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
        {...SNAP}
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

/**
 * Every row comes to rest with a card on the page margin.
 *
 * Without it a fling stopped wherever momentum ran out, so one row sat with a
 * half card at the left edge and the next with a gap — the rows no longer
 * lined up with the grid above them or with each other. One card plus one gap
 * per step: with the list's own S.gutter padding, step k puts card k exactly
 * at the gutter, the same line the section titles start on.
 */
const SNAP = {
  snapToInterval: CARD + S.gap,
  snapToAlignment: 'start',
  decelerationRate: 'fast',
} as const;

const styles = StyleSheet.create({
  fill: {flex: 1},
  // The bars at the foot of the app float OVER the page now, so a list has to
  // end above them or its last row is permanently behind one. See src/layout.ts.
  scroll: {paddingBottom: BOTTOM_INSET},
  // The pinned row, spaced like the title bars of Search and Your Library.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: S.gutter,
    paddingTop: 14,
    paddingBottom: 10,
    gap: 12,
  },
  headerText: {flex: 1, minWidth: 0},
  // The mark's width (MenuMark: 38).
  markSpacer: {width: 38},
  title: {
    ...T.screenTitle,
    color: C.text,
    paddingHorizontal: S.gutter,
    paddingTop: 8,
    paddingBottom: 4,
  },
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
