import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  BackHandler,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  View,
} from 'react-native';
import {ErrorBoundary} from './src/ErrorBoundary';
import {HomeScreen} from './src/screens/HomeScreen';
import {SearchScreen} from './src/screens/SearchScreen';
import {LibraryScreen} from './src/screens/LibraryScreen';
import {SettingsScreen} from './src/screens/SettingsScreen';
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
import {checkUpdate} from './src/update';
import {
  TrackActionSheet,
  type SheetContext,
} from './src/components/TrackActionSheet';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {C} from './src/theme';
import {getAlbum, getCollection, type HomeItem, type Track} from './src/backend';
import {
  playTrack,
  restoreSession,
  setupPlayer,
  startCrossfadeWatcher,
} from './src/player';
import {hydrate, readSettings} from './src/store';
import {normalizeTracks, splitArtists} from './src/tracks';
import {type Collection} from './src/collections';
import {applyAudioEffects} from './src/audioEffects';
import {toggleFollow} from './src/artists';
import {toast} from './src/toast';

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
  const [playerOpen, setPlayerOpen] = useState(false);
  // null = not yet determined, false = this APK has no native audio engine.
  const [engine, setEngine] = useState<boolean | null>(null);
  const [libraryNonce, setLibraryNonce] = useState(0);
  const exitArmedAt = useRef(0);

  useEffect(() => {
    hydrate().then(applyAudioEffects);
    // Boot the engine, then restore the last session so the mini player is
    // there on reopen (same song, paused, at the timestamp you left).
    setupPlayer().then(async ok => {
      setEngine(ok);
      if (ok) {
        const restored = await restoreSession();
        if (restored) {
          // Force the shell to show the player bar even though nothing was
          // tapped this launch.
          setEngine(true);
        }
      }
    });
    // Reads the setting each tick rather than closing over it, so changing
    // crossfade takes effect without restarting the watcher.
    startCrossfadeWatcher(() => readSettings().crossfadeDuration);
    // Silent update check on launch — the popup only appears if a newer release
    // is actually out. Delayed a little so it never competes with cold start.
    const u = setTimeout(checkUpdate, 3500);
    return () => clearTimeout(u);
  }, []);

  const play = useCallback(async (track: Track, context?: Track[]) => {
    try {
      await playTrack(track, context);
      setEngine(true);
    } catch (e) {
      // A toast, not a bar in the layout: the old notice sat above the mini
      // player and covered it, hiding the song that was actually playing.
      toast(e instanceof Error ? e.message : String(e));
    }
  }, []);

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
              ? {...prev, name: data.name || albumName, tracks: normalizeTracks(data.tracks)}
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

  const switchTab = useCallback((next: Tab) => {
    setTab(next);
    setCollection(null);
    setArtist(null);
    setImportUrl(null);
    setSettingsOpen(false);
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
  useEffect(() => {
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

    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [
    playerOpen,
    addTo,
    artistChoices,
    sheetTrack,
    settingsOpen,
    artist,
    artistZ,
    importUrl,
    collection,
    collectionZ,
    tab,
  ]);

  const openSheet = useCallback((track: Track, from?: SheetContext) => {
    setSheetTrack(track);
    setSheetFrom(from ?? null);
  }, []);

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
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </View>
        <View style={tab === 'search' ? styles.tabShown : styles.tabHidden}>
          <SearchScreen
            onPickTrack={play}
            onImportSpotify={setImportUrl}
            onMenu={openSheet}
            onOpenArtist={openArtist}
          />
        </View>
        <View style={tab === 'library' ? styles.tabShown : styles.tabHidden}>
          <LibraryScreen
            key={libraryNonce}
            visible={tab === 'library'}
            onOpen={c =>
              // A followed artist opens their profile, not an empty tracklist.
              c.kind === 'artist' ? openArtist(c.name) : openCollection(c)
            }
          />
        </View>

        {/* Overlays, innermost last. */}
        {!!collection && (
          <View style={[StyleSheet.absoluteFill, {zIndex: collectionZ}]}>
            <CollectionScreen
              collection={collection}
              loading={collectionLoading}
              onClose={() => setCollection(null)}
              onPlay={play}
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
                  toggleFollow(n, img)
                    ? `Following ${n}`
                    : `Unfollowed ${n}`,
                )
              }
              onOpenAlbum={openAlbumByName}
            />
          </View>
        )}
        {/* Settings is an overlay, not a Modal, for the same reason as the
            rest: a Modal floats over the whole window and hid the mini player.
            Here it stays inside the body, so playback controls remain visible. */}
        {settingsOpen && (
          <View style={StyleSheet.absoluteFill}>
            <SettingsScreen onClose={() => setSettingsOpen(false)} />
          </View>
        )}
      </View>

      <Toaster bottom={engine ? 132 : 78} />

      {engine && <PlayerBar onExpand={() => setPlayerOpen(true)} />}

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
          onClose={() => setPlayerOpen(false)}
          onAddToPlaylist={setAddTo}
          onOpenArtist={openArtistCredit}
        />
      )}

      <UpdateModal />
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
  tabShown: {...StyleSheet.absoluteFillObject},
  tabHidden: {...StyleSheet.absoluteFillObject, display: 'none'},
});
