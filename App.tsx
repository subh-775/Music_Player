import React, {useCallback, useEffect, useState} from 'react';
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
import {
  TrackActionSheet,
  type SheetContext,
} from './src/components/TrackActionSheet';
import {C} from './src/theme';
import {getAlbum, getCollection, type HomeItem, type Track} from './src/backend';
import {playTrack, setupPlayer, startCrossfadeWatcher} from './src/player';
import {hydrate, readSettings} from './src/store';
import {normalizeTracks, splitArtists} from './src/tracks';
import {type Collection} from './src/collections';
import {applyAudioEffects} from './src/audioEffects';
import {isFollowing, toggleFollow} from './src/artists';
import {toast} from './src/toast';

function Shell() {
  const [tab, setTab] = useState<Tab>('home');
  // A small navigation stack of overlays. These are plain absolutely-positioned
  // views rather than <Modal>s ON PURPOSE: a Modal renders in its own window
  // above everything, which is what hid the mini player and the bottom nav the
  // moment you opened a playlist. As overlays they sit inside the app's own
  // layout, so playback controls stay put while you browse.
  const [collection, setCollection] = useState<Collection | null>(null);
  const [importUrl, setImportUrl] = useState<string | null>(null);
  const [artist, setArtist] = useState<string | null>(null);

  const [sheetTrack, setSheetTrack] = useState<Track | null>(null);
  const [sheetFrom, setSheetFrom] = useState<SheetContext>(null);
  const [addTo, setAddTo] = useState<Track | null>(null);
  const [artistChoices, setArtistChoices] = useState<string[]>([]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);
  // null = not yet determined, false = this APK has no native audio engine.
  const [engine, setEngine] = useState<boolean | null>(null);
  const [libraryNonce, setLibraryNonce] = useState(0);

  useEffect(() => {
    hydrate().then(applyAudioEffects);
    setupPlayer().then(setEngine);
    // Reads the setting each tick rather than closing over it, so changing
    // crossfade takes effect without restarting the watcher.
    startCrossfadeWatcher(() => readSettings().crossfadeDuration);
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

  /** A single credited artist opens directly; several ask which one first. */
  const openArtistCredit = useCallback((credit: string) => {
    const names = splitArtists(credit);
    if (names.length > 1) {
      setArtistChoices(names);
    } else if (names.length === 1) {
      setArtist(names[0]);
    }
  }, []);

  const openAlbumOf = useCallback((track: Track) => {
    if (!track.album) {
      return;
    }
    // Album pages are keyed by name+artist; the collection screen renders
    // whatever tracks we already hold until a fuller fetch exists.
    setCollection({
      id: `album:${track.album}`,
      kind: 'album',
      name: track.album,
      artist: track.artist,
      image: track.artwork_url,
      tracks: [track],
    });
  }, []);

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
        setCollection({
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
    [play],
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
      if (artist) {
        setArtist(null);
        return true;
      }
      if (importUrl) {
        setImportUrl(null);
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
      return false;
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
    importUrl,
    collection,
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
        {tab === 'home' && (
          <HomeScreen
            onPickTrack={pickHomeItem}
            onPlayTrack={play}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}
        {tab === 'search' && (
          <SearchScreen
            onPickTrack={play}
            onImportSpotify={setImportUrl}
            onMenu={openSheet}
          />
        )}
        {tab === 'library' && (
          <LibraryScreen
            key={libraryNonce}
            onOpen={c =>
              // A followed artist opens their profile, not an empty tracklist.
              c.kind === 'artist' ? setArtist(c.name) : setCollection(c)
            }
          />
        )}

        {/* Overlays, innermost last. */}
        {!!collection && (
          <View style={StyleSheet.absoluteFill}>
            <CollectionScreen
              collection={collection}
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
          <View style={StyleSheet.absoluteFill}>
            <ArtistScreen
              name={artist}
              onClose={() => setArtist(null)}
              onPlay={play}
              onMenu={openSheet}
              following={isFollowing(artist)}
              onToggleFollow={(n, img) =>
                toast(
                  toggleFollow(n, img)
                    ? `Following ${n}`
                    : `Unfollowed ${n}`,
                )
              }
              onOpenAlbum={(albumName, artistName) =>
                setCollection({
                  id: `album:${albumName}`,
                  kind: 'album',
                  name: albumName,
                  artist: artistName,
                  tracks: [],
                })
              }
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
          setArtist(name);
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
    </SafeAreaView>
  );
}

export default function App(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <Shell />
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: C.bg},
  body: {flex: 1},
});
