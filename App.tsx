import React, {useCallback, useEffect, useState} from 'react';
import {
  Modal,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
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
import {C, S} from './src/theme';
import {getCollection, type HomeItem, type Track} from './src/backend';
import {playTrack, setupPlayer, startCrossfadeWatcher} from './src/player';
import {hydrate, readSettings} from './src/store';
import {normalizeTracks, splitArtists} from './src/tracks';
import {type Collection} from './src/collections';
import {applyAudioEffects} from './src/audioEffects';
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
  const [notice, setNotice] = useState('');
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
      setNotice('');
      setEngine(true);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
      setEngine(false);
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
        const data = await getCollection(item.perma_url);
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
  }, []);

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
          <LibraryScreen key={libraryNonce} onOpen={setCollection} />
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
            />
          </View>
        )}
      </View>

      {/* Shown only when playback genuinely isn't available. */}
      {!!notice && (
        <TouchableOpacity style={styles.notice} onPress={() => setNotice('')}>
          <Text style={styles.noticeText}>{notice}</Text>
        </TouchableOpacity>
      )}

      <Toaster bottom={engine ? 132 : 78} />

      {engine && <PlayerBar onExpand={() => setPlayerOpen(true)} />}

      <BottomNav active={tab} onChange={switchTab} />

      <Modal
        visible={settingsOpen}
        animationType="slide"
        onRequestClose={() => setSettingsOpen(false)}>
        <SettingsScreen onClose={() => setSettingsOpen(false)} />
      </Modal>

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
  notice: {
    backgroundColor: C.surfaceHi,
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingHorizontal: S.gutter,
    paddingVertical: 11,
  },
  noticeText: {color: C.sub, fontSize: 12.5, lineHeight: 17},
});
