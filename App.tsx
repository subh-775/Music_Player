import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  BackHandler,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  View,
} from 'react-native';
import {ErrorBoundary} from './src/ErrorBoundary';
import {HomeScreen, type QuickDest} from './src/screens/HomeScreen';
import {ActivityScreen} from './src/screens/ActivityScreen';
import {SearchScreen} from './src/screens/SearchScreen';
import {LibraryScreen} from './src/screens/LibraryScreen';
import {
  SettingsScreen,
  prefetchSettingsRemote,
} from './src/screens/SettingsScreen';
import {TipsScreen} from './src/screens/TipsScreen';
import {EqualizerScreen} from './src/screens/EqualizerScreen';
import {CollectionScreen} from './src/screens/CollectionScreen';
import {SpotifyImportScreen} from './src/screens/SpotifyImportScreen';
import {ArtistScreen} from './src/screens/ArtistScreen';
import {PlayerScreen} from './src/screens/PlayerScreen';
import {PlayerBar} from './src/components/PlayerBar';
import {BottomNav, type Tab} from './src/components/BottomNav';
import {Toaster} from './src/components/Toaster';
import {AddToPlaylistSheet} from './src/components/AddToPlaylistSheet';
import {ArtistPickerSheet} from './src/components/ArtistPickerSheet';
import {UpdateModal} from './src/components/UpdateModal';
import {
  checkUpdateOnLaunch,
  useUpdateAvailable,
  watchForegroundUpdates,
} from './src/update';
import {
  TrackActionSheet,
  type SheetContext,
} from './src/components/TrackActionSheet';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {Splash} from './src/components/Splash';
import {Sidebar, type SidebarDest} from './src/components/Sidebar';
import {SleepSheet} from './src/components/SleepSheet';
import {resetDrawer, settleDrawer} from './src/drawer';
import {C} from './src/theme';
import {
  appVersion,
  getAlbum,
  getCollection,
  getLocalLibrary,
  type HomeItem,
  type Track,
} from './src/backend';
import {
  downloadsCollection,
  likedCollection,
  playlistToCollection,
} from './src/collections';
import {readPlaylists} from './src/playlists';
import {overlayDownloadArtwork} from './src/downloads';
import {
  playTrack,
  restoreSession,
  setupPlayer,
  startCrossfadeWatcher,
} from './src/player';
import {hydrate, readSettings, useLikes} from './src/store';
import {normalizeTracks, splitArtists} from './src/tracks';
import {type Collection} from './src/collections';
import {applyAudioEffects} from './src/audioEffects';
import {toggleFollow} from './src/artists';
import {toast} from './src/toast';
import {diag} from './src/diag';

function Shell() {
  const [tab, setTab] = useState<Tab>('home');
  // A small navigation stack of overlays. These are plain absolutely-positioned
  // views rather than <Modal>s ON PURPOSE: a Modal renders in its own window
  // above everything, which is what hid the mini player and the bottom nav the
  // moment you opened a playlist. As overlays they sit inside the app's own
  // layout, so playback controls stay put while you browse.
  const [collection, setCollection] = useState<Collection | null>(null);
  const [collectionLoading, setCollectionLoading] = useState(false);
  const [importUrl, setImportUrl] = useState<string | null>(null);
  const [artist, setArtist] = useState<string | null>(null);
  // Whichever overlay was opened LAST renders on top. Fixed JSX order put the
  // album under the artist page — it opened invisibly, which read as "albums
  // don't work". zIndex from a counter mirrors the order things were opened.
  const zRef = useRef(0);
  const [collectionZ, setCollectionZ] = useState(0);
  const [artistZ, setArtistZ] = useState(0);

  const [sheetTrack, setSheetTrack] = useState<Track | null>(null);
  const [sheetFrom, setSheetFrom] = useState<SheetContext>(null);
  const [addTo, setAddTo] = useState<Track | null>(null);
  const [artistChoices, setArtistChoices] = useState<string[]>([]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Which part of Settings to land on. Set when the update dot is what sent
   *  you there, so you arrive at the update instead of the top of the list. */
  const [settingsFocus, setSettingsFocus] = useState<'update' | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** Shortcuts, opened from the drawer. Its own overlay, not nested inside
   *  Settings — see navigateFromDrawer. */
  const [tipsOpen, setTipsOpen] = useState(false);
  /** Equalizer, same reasoning as Shortcuts. Settings keeps its own row and
   *  both point at the one component. */
  const [eqOpen, setEqOpen] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [sleepOpen, setSleepOpen] = useState(false);
  // null = not yet determined, false = this APK has no native audio engine.
  const [engine, setEngine] = useState<boolean | null>(null);
  const [libraryNonce, setLibraryNonce] = useState(0);
  /** The drawer's Recents / Your sound pages. null = closed. */
  const [activity, setActivity] = useState<'recents' | 'stats' | null>(null);
  const likes = useLikes();
  const updateWaiting = useUpdateAvailable();
  const exitArmedAt = useRef(0);

  /**
   * One gate for the whole cold start.
   *
   * The splash used to live INSIDE HomeScreen, so it only ever covered Home's
   * own content — the shell, the mini player and its progress bar all arrived
   * afterwards, which is why the app visibly assembled itself in stages. Now
   * the real UI mounts underneath the splash and the splash only lifts once
   * BOTH the engine (session restored, so the mini player is already there)
   * and Home's first rows are ready. Nothing pops in after that.
   */
  const [booted, setBooted] = useState(false);
  const engineDone = useRef(false);
  const homeDone = useRef(false);
  const liftSplash = useCallback(() => {
    if (engineDone.current && homeDone.current) {
      setBooted(true);
    }
  }, []);
  const onHomeReady = useCallback(() => {
    homeDone.current = true;
    liftSplash();
  }, [liftSplash]);

  useEffect(() => {
    // First line of every session. Also the proof that the logcat bridge is
    // alive — if `adb logcat -s MPJS` shows nothing at all, the problem is the
    // logging, not the thing being investigated.
    diag('boot', `Music_Player ${appVersion || '?'} starting`);
    hydrate().then(applyAudioEffects);
    // Boot the engine, then restore the last session so the mini player is
    // there on reopen (same song, paused, at the timestamp you left).
    setupPlayer().then(async ok => {
      diag(
        'boot',
        ok ? 'audio engine ready' : 'NO native audio engine in this APK',
      );
      setEngine(ok);
      if (ok) {
        const restored = await restoreSession();
        if (restored) {
          // Force the shell to show the player bar even though nothing was
          // tapped this launch.
          setEngine(true);
        }
      }
      engineDone.current = true;
      liftSplash();
    });
    // Never let a hung backend strand anyone on the splash. Whatever is ready
    // at this point is what they get.
    const bootCap = setTimeout(() => {
      engineDone.current = true;
      homeDone.current = true;
      setBooted(true);
    }, 6000);
    // Reads the setting each tick rather than closing over it, so changing
    // crossfade takes effect without restarting the watcher.
    startCrossfadeWatcher(() => readSettings().crossfadeDuration);
    // Silent update check on launch — the popup only appears if a newer release
    // is actually out. Delayed a little so it never competes with cold start.
    const u = setTimeout(checkUpdateOnLaunch, 3500);
    // …and again on every return to the foreground, because a process kept
    // alive by the playback service may not launch again for days.
    watchForegroundUpdates();
    return () => {
      clearTimeout(u);
      clearTimeout(bootCap);
    };
  }, [liftSplash]);

  const play = useCallback(
    async (track: Track, context?: Track[], originId?: string) => {
      try {
        await playTrack(track, context, originId);
        setEngine(true);
      } catch (e) {
        // A toast, not a bar in the layout: the old notice sat above the mini
        // player and covered it, hiding the song that was actually playing.
        diag('play', `"${track?.title}" failed: ${String(e)}`);
        toast(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  /** A single credited artist opens directly; several ask which one first.
   *  Either way the full player closes first — the artist page renders in the
   *  body, and a Modal player would sit on top of it, which is why "clicked
   *  the artist, nothing happened until I pressed back". */
  const openCollection = useCallback((c: Collection) => {
    setCollection(c);
    setCollectionZ(++zRef.current);
  }, []);

  const openArtist = useCallback((name: string) => {
    setPlayerOpen(false);
    setArtist(name);
    setArtistZ(++zRef.current);
  }, []);

  const openArtistCredit = useCallback(
    (credit: string) => {
      const names = splitArtists(credit);
      if (names.length > 1) {
        // The picker is a sheet OVER whatever is open — the player stays put
        // until an actual artist is chosen.
        setArtistChoices(names);
      } else if (names.length === 1) {
        openArtist(names[0]);
      }
    },
    [openArtist],
  );

  /** Open an album AS ITS FULL SELF: fetch the real tracklist by name+artist.
   *  Seed tracks (what we already hold) show instantly; the fetch replaces
   *  them when it lands, so the screen is never empty and never stale. */
  const openAlbumByName = useCallback(
    async (albumName: string, artistName: string, seed: Track[] = []) => {
      setCollection({
        id: `album:${albumName}`,
        kind: 'album',
        name: albumName,
        artist: artistName,
        image: seed[0]?.artwork_url,
        tracks: seed,
      });
      setCollectionZ(++zRef.current);
      setCollectionLoading(true);
      try {
        const data = await getAlbum(albumName, artistName);
        if (data.tracks.length) {
          setCollection(prev =>
            prev && prev.id === `album:${albumName}`
              ? {
                  ...prev,
                  name: data.name || albumName,
                  tracks: normalizeTracks(data.tracks),
                }
              : prev,
          );
        }
      } catch {
        // The seed tracks stay — a partial album beats an error screen.
      } finally {
        setCollectionLoading(false);
      }
    },
    [],
  );

  const openAlbumOf = useCallback(
    (track: Track) => {
      if (!track.album) {
        return;
      }
      openAlbumByName(track.album, track.artist, [track]);
    },
    [openAlbumByName],
  );

  /** A Home card is a track, album or playlist. Tracks play; the rest open —
   *  as a Collection, the same as anything in the library. */
  const pickHomeItem = useCallback(
    async (item: HomeItem) => {
      if (item.type === 'track' && item.track) {
        play(item.track);
        return;
      }
      if (!item.perma_url) {
        return;
      }
      try {
        let data = await getCollection(item.perma_url);
        // Not every album URL resolves through /api/playlist; fall back to the
        // album endpoint before reporting failure, rather than opening empty.
        if (!data.tracks.length && item.type === 'album') {
          data = await getAlbum(item.name || item.title || '', item.subtitle);
        }
        if (!data.tracks.length) {
          toast('That one has no playable songs right now.');
          return;
        }
        openCollection({
          id: item.perma_url,
          kind: item.type === 'album' ? 'album' : 'sourcePlaylist',
          name: data.name || item.title || item.name || '',
          image: item.image,
          tracks: normalizeTracks(data.tracks),
          source: item.perma_url,
        });
      } catch {
        toast("Couldn't open that — try again in a moment.");
      }
    },
    [play, openCollection],
  );

  /** Home's quick-access tiles. Home only knows WHAT was tapped; the
   *  tracklists live here, next to everything else that opens a Collection. */
  const openQuick = useCallback(
    async (dest: QuickDest) => {
      if (dest.kind === 'liked') {
        openCollection(likedCollection(likes));
        return;
      }
      if (dest.kind === 'downloads') {
        try {
          const {tracks} = await getLocalLibrary();
          // Same as the Library tab: the disk scan carries no artwork, so lay
          // back the covers remembered at download time.
          openCollection(downloadsCollection(overlayDownloadArtwork(tracks)));
        } catch {
          toast("Couldn't read your downloads.");
        }
        return;
      }
      const p = readPlaylists().find(x => x.id === dest.id);
      if (p) {
        openCollection(playlistToCollection(p));
      }
    },
    [likes, openCollection],
  );

  const switchTab = useCallback((next: Tab) => {
    setTab(next);
    setCollection(null);
    setArtist(null);
    setImportUrl(null);
    setSettingsOpen(false);
    setTipsOpen(false);
    setActivity(null);
  }, []);

  /**
   * Android's back button must walk the same stack the on-screen back arrow
   * does. Without this it fell through to the OS and closed the whole app from
   * inside a playlist, which is the one thing back should never do here.
   *
   * Order matters: innermost surface first, so back dismisses what is actually
   * on top. Returning true says "handled"; returning false on the last screen
   * lets Android exit, which IS what back means on Home.
   */
  const onBack = () => {
    if (playerOpen) {
      setPlayerOpen(false);
      return true;
    }
    if (addTo) {
      setAddTo(null);
      return true;
    }
    if (artistChoices.length) {
      setArtistChoices([]);
      return true;
    }
    if (sheetTrack) {
      setSheetTrack(null);
      return true;
    }
    if (settingsOpen) {
      setSettingsOpen(false);
      setSettingsFocus(null);
      return true;
    }
    if (tipsOpen) {
      setTipsOpen(false);
      return true;
    }
    // The Equalizer was simply never in this chain. It is a full-screen overlay
    // like Shortcuts, so back fell straight through it to `tab !== 'home'` or to
    // the exit warning and the screen stayed up.
    if (eqOpen) {
      setEqOpen(false);
      return true;
    }
    if (activity) {
      setActivity(null);
      return true;
    }
    if (importUrl) {
      setImportUrl(null);
      return true;
    }
    // Artist and album/playlist overlays stack in either order (open an album
    // FROM an artist, or an artist from an album), so back must dismiss the one
    // actually on TOP — by z-order — not a fixed priority. Otherwise back closed
    // the screen underneath and left the visible one stuck.
    if (artist && collection) {
      if (artistZ >= collectionZ) {
        setArtist(null);
      } else {
        setCollection(null);
      }
      return true;
    }
    if (artist) {
      setArtist(null);
      return true;
    }
    if (collection) {
      setCollection(null);
      return true;
    }
    // Any tab other than Home goes to Home before the app will exit.
    if (tab !== 'home') {
      setTab('home');
      return true;
    }
    // On Home with nothing open, one press warns, a second within 2s exits —
    // so a stray back can't kill the music by accident.
    if (Date.now() - exitArmedAt.current < 2000) {
      return false;
    }
    exitArmedAt.current = Date.now();
    toast('Press back again to exit', 'warn');
    return true;
  };

  /**
   * Registered ONCE, and called through a ref.
   *
   * It used to re-register on any of thirteen dependencies, so nearly every
   * state change in the app tore the listener down and added a fresh one. That
   * is not just churn: BackHandler calls its listeners in REVERSE registration
   * order, so re-adding this one kept moving the app-wide fallback to the FRONT
   * of the queue, ahead of the per-surface handlers in Sheet, Sidebar and
   * PlayerScreen that were registered when those opened. The player then closed
   * via setPlayerOpen(false) — no settle animation — instead of through its own
   * close(), and a sheet's own dismiss could be pre-empted outright.
   *
   * Registered once at mount, this handler is the OLDEST, so it is called LAST,
   * which is exactly what a fallback should be. The ref keeps the closure fresh
   * without touching the subscription.
   */
  const backRef = useRef(onBack);
  backRef.current = onBack;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () =>
      backRef.current(),
    );
    return () => sub.remove();
  }, []);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  /**
   * Opening by TAP: mount the panel closed, then run it open. The drag path
   * (below) skips the animation entirely because the finger IS the animation.
   */
  const openDrawer = useCallback(() => {
    resetDrawer();
    setDrawerOpen(true);
    settleDrawer(true);
    // Start Settings' four backend reads NOW. Opening the drawer is the only
    // gesture that ever precedes opening Settings, and it buys the whole
    // animation plus however long the finger takes to reach the last row — by
    // which point the answers are usually already back and Settings opens
    // finished instead of filling in.
    prefetchSettingsRemote();
  }, []);

  /** A drawer pull has begun. Mount without animating — HomeScreen has already
   *  parked the panel off-screen and is about to drive it directly. */
  const beginDrawerDrag = useCallback(() => {
    setDrawerOpen(true);
    prefetchSettingsRemote();
  }, []);

  /** The finger lifted. Carry its speed into the settle, and unmount only once
   *  a close has actually finished — unmounting early would snap it away
   *  mid-animation. */
  const endDrawerDrag = useCallback((open: boolean, velocity: number) => {
    settleDrawer(open, velocity, finished => {
      if (finished && !open) {
        setDrawerOpen(false);
      }
    });
  }, []);

  const navigateFromDrawer = useCallback(
    (dest: SidebarDest) => {
      if (dest === 'settings') {
        setSettingsFocus(updateWaiting ? 'update' : null);
        setSettingsOpen(true);
      } else if (dest === 'equalizer') {
        // Its OWN overlay, not Settings-with-a-panel-preset. Same reasoning the
        // Shortcuts entry already carries: back from a drawer destination has
        // to return to where the drawer was opened, not drop you into a
        // Settings list you never asked to see.
        setEqOpen(true);
      } else if (dest === 'sleep') {
        setSleepOpen(true);
      } else if (dest === 'shortcuts') {
        // Its OWN overlay, not a panel pushed inside Settings. It used to be —
        // Settings would mount underneath with panel='tips' — so back from
        // Shortcuts revealed a full Settings LIST the user never asked to open,
        // landing them somewhere unrelated to what they tapped in the drawer.
        // Shortcuts is reached from the drawer; its back should return to
        // wherever the drawer was opened from, same as every other drawer item.
        setTipsOpen(true);
      } else if (dest === 'stats') {
        setActivity(dest);
      }
      // updateWaiting is read above, so it has to be a dependency — with an empty
      // array this closure would keep whatever the flag was on first render and
      // the deep link would never fire.
    },
    [updateWaiting],
  );

  const openSheet = useCallback((track: Track, from?: SheetContext) => {
    setSheetTrack(track);
    setSheetFrom(from ?? null);
  }, []);

  /**
   * Stable identities for the memoised children below.
   *
   * These three were inline arrows, which meant a new function on every App
   * render — and a new function is a changed prop, so React.memo on the child
   * would have been defeated silently by the props rather than by anything
   * visible. The rest of the children's callbacks were already useCallback.
   */
  const openFromLibrary = useCallback(
    (c: Collection) =>
      // A followed artist opens their profile, not an empty tracklist.
      c.kind === 'artist' ? openArtist(c.name) : openCollection(c),
    [openArtist, openCollection],
  );
  const closePlayer = useCallback(() => setPlayerOpen(false), []);
  const expandPlayer = useCallback(() => setPlayerOpen(true), []);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      <View style={styles.body}>
        {/* All three tabs stay MOUNTED; switching shows/hides them. Unmounting
            threw away each screen's state, so coming back to Home replayed
            "Starting the music engine…" and Library re-fetched everything —
            the single biggest "why is it reloading" complaint. */}
        <View style={tab === 'home' ? styles.tabShown : styles.tabHidden}>
          <HomeScreen
            onPickTrack={pickHomeItem}
            onPlayTrack={play}
            onOpenMenu={openDrawer}
            onBeginDrag={beginDrawerDrag}
            onEndDrag={endDrawerDrag}
            onOpenQuick={openQuick}
            onReady={onHomeReady}
          />
        </View>
        <View style={tab === 'search' ? styles.tabShown : styles.tabHidden}>
          <SearchScreen
            visible={tab === 'search'}
            onPickTrack={play}
            onImportSpotify={setImportUrl}
            onMenu={openSheet}
            onOpenArtist={openArtist}
            onOpenBrowse={pickHomeItem}
          />
        </View>
        <View style={tab === 'library' ? styles.tabShown : styles.tabHidden}>
          <LibraryScreen
            key={libraryNonce}
            visible={tab === 'library'}
            onOpen={openFromLibrary}
          />
        </View>

        {/* Overlays, innermost last. */}
        {!!collection && (
          <View style={[StyleSheet.absoluteFill, {zIndex: collectionZ}]}>
            <CollectionScreen
              collection={collection}
              loading={collectionLoading}
              onClose={() => setCollection(null)}
              // The only play path with a collection behind it, so the only one
              // that can tell the library where playback started. Everything
              // else — search, radio, a tap on Home — passes nothing, which is
              // the honest answer for a queue that came from no collection.
              onPlay={(t, ctx) => play(t, ctx, collection.id)}
              onMenu={openSheet}
              onChanged={() => {
                setCollection(null);
                setLibraryNonce(n => n + 1);
              }}
            />
          </View>
        )}

        {!!importUrl && (
          <View style={StyleSheet.absoluteFill}>
            <SpotifyImportScreen
              url={importUrl}
              onClose={() => setImportUrl(null)}
              onPlay={play}
            />
          </View>
        )}

        {!!artist && (
          <View style={[StyleSheet.absoluteFill, {zIndex: artistZ}]}>
            <ArtistScreen
              name={artist}
              onClose={() => setArtist(null)}
              onPlay={play}
              onMenu={openSheet}
              onToggleFollow={(n, img) =>
                toast(
                  toggleFollow(n, img) ? `Following ${n}` : `Unfollowed ${n}`,
                )
              }
              onOpenAlbum={openAlbumByName}
            />
          </View>
        )}
        {!!activity && (
          <View style={StyleSheet.absoluteFill}>
            <ActivityScreen
              mode={activity}
              onClose={() => setActivity(null)}
              onPlay={play}
              onMenu={openSheet}
              onOpenArtist={openArtist}
            />
          </View>
        )}

        {/* Settings is an overlay, not a Modal, for the same reason as the
            rest: a Modal floats over the whole window and hid the mini player.
            Here it stays inside the body, so playback controls remain visible. */}
        {settingsOpen && (
          <View style={StyleSheet.absoluteFill}>
            <SettingsScreen
              focus={settingsFocus}
              onClose={() => {
                setSettingsOpen(false);
                // Cleared on the way out, or opening Settings normally next
                // time would scroll to the update again.
                setSettingsFocus(null);
              }}
            />
          </View>
        )}

        {tipsOpen && (
          <View style={StyleSheet.absoluteFill}>
            <TipsScreen onClose={() => setTipsOpen(false)} />
          </View>
        )}

        {eqOpen && (
          <View style={StyleSheet.absoluteFill}>
            <EqualizerScreen onClose={() => setEqOpen(false)} />
          </View>
        )}
      </View>

      {/*
        ONE outlet, app-wide.

        There used to be a second inside PlayerScreen, because when the player
        was a Modal it was a separate Dialog window and this one genuinely was
        behind it. The player is a view at zIndex 30 now and the toaster is at
        9999, so this paints OVER it — and both outlets, subscribed to the same
        singleton in toast.ts, were rendering the same message at once.

        All it needs is to clear the player's own transport when the player is
        up, rather than sitting at the mini player's height.
      */}
      <Toaster bottom={playerOpen ? 118 : engine ? 132 : 78} />

      {engine && <PlayerBar onExpand={expandPlayer} />}

      <BottomNav active={tab} onChange={switchTab} />

      <TrackActionSheet
        track={sheetTrack}
        from={sheetFrom}
        onClose={() => setSheetTrack(null)}
        onAddToPlaylist={setAddTo}
        onOpenArtist={t => openArtistCredit(t.artist)}
        onOpenAlbum={openAlbumOf}
      />

      <AddToPlaylistSheet track={addTo} onClose={() => setAddTo(null)} />

      <ArtistPickerSheet
        names={artistChoices}
        onClose={() => setArtistChoices([])}
        onPick={name => {
          setArtistChoices([]);
          openArtist(name); // closes the player too — the profile is behind it
        }}
      />

      {engine && (
        <PlayerScreen
          visible={playerOpen}
          onClose={closePlayer}
          onAddToPlaylist={setAddTo}
          onOpenArtist={openArtistCredit}
        />
      )}

      <SleepSheet open={sleepOpen} onClose={() => setSleepOpen(false)} />

      <UpdateModal />

      {/* Above everything, and the real UI is already mounted and painted
          underneath — so lifting this reveals a finished screen rather than
          starting the loading the user can watch. */}
      {/* Last in the tree and absolutely positioned, so it covers the mini
          player and the bottom nav the way a drawer should — but it is NOT a
          Modal, because a Modal is its own window and cannot be dragged into
          view underneath a gesture that is already in progress. Its position is
          the shared drawerX; see src/drawer.ts.

          Both handlers are stable. Inline arrows here gave the drawer a new
          onClose on every app re-render, which used to re-run its open effect
          and slam the panel back open over the page it had just opened. */}
      <Sidebar
        visible={drawerOpen}
        onClose={closeDrawer}
        onNavigate={navigateFromDrawer}
      />

      {!booted && (
        <View style={styles.splash} pointerEvents="auto">
          <Splash />
        </View>
      )}
    </SafeAreaView>
  );
}

export default function App(): React.JSX.Element {
  return (
    // GestureHandlerRootView must wrap everything that uses a gesture handler
    // (the queue's drag-to-reorder). Without it the handlers mount but never
    // receive touches, so the drag silently does nothing.
    <GestureHandlerRootView style={styles.safe}>
      <ErrorBoundary>
        <Shell />
      </ErrorBoundary>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: C.bg},
  body: {flex: 1},
  // Above every overlay: player 30, sheets 40, drawer 45. The splash is the
  // one thing that must cover a half-built app.
  splash: {...StyleSheet.absoluteFillObject, zIndex: 60, backgroundColor: C.bg},
  tabShown: {...StyleSheet.absoluteFillObject},
  tabHidden: {...StyleSheet.absoluteFillObject, display: 'none'},
});
