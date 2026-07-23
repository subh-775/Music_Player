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
import {PlayerScreen} from './src/screens/PlayerScreen';
import {PlayerBar} from './src/components/PlayerBar';
import {BottomNav, type Tab} from './src/components/BottomNav';
import {Toaster} from './src/components/Toaster';
import {AddToPlaylistSheet} from './src/components/AddToPlaylistSheet';
import {C, S} from './src/theme';
import {getCollection, type HomeItem, type Track} from './src/backend';
import {playTrack, setupPlayer} from './src/player';
import {hydrate} from './src/store';
import {normalizeTracks} from './src/tracks';
import {type Collection} from './src/collections';
import {toast} from './src/toast';

function Shell() {
  const [tab, setTab] = useState<Tab>('home');
  // One stack slot: whatever collection is open, wherever it came from.
  const [open, setOpen] = useState<Collection | null>(null);
  const [importUrl, setImportUrl] = useState<string | null>(null);
  const [addTo, setAddTo] = useState<Track | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);
  // null = not yet determined, false = this APK has no native audio engine.
  const [engine, setEngine] = useState<boolean | null>(null);
  const [notice, setNotice] = useState('');
  // Bumped after downloads are deleted, so the library rescans disk.
  const [, setRefresh] = useState(0);

  useEffect(() => {
    hydrate();
    setupPlayer().then(setEngine);
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

  /** A Home card is a track, album or playlist. Tracks play; the rest open —
   *  and they open as a Collection, the same as anything in the library. */
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
        setOpen({
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

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      <View style={styles.body}>
        {tab === 'home' && <HomeScreen onPickTrack={pickHomeItem} />}
        {tab === 'search' && (
          <SearchScreen onPickTrack={play} onImportSpotify={setImportUrl} />
        )}
        {tab === 'library' && (
          <LibraryScreen
            onOpen={setOpen}
            onOpenSettings={() => setSettingsOpen(true)}
          />
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

      <BottomNav active={tab} onChange={setTab} />

      <Modal
        visible={!!open}
        animationType="slide"
        onRequestClose={() => setOpen(null)}>
        {!!open && (
          <CollectionScreen
            collection={open}
            onClose={() => setOpen(null)}
            onPlay={play}
            onChanged={() => {
              setOpen(null);
              setRefresh(n => n + 1);
            }}
          />
        )}
      </Modal>

      <Modal
        visible={!!importUrl}
        animationType="slide"
        onRequestClose={() => setImportUrl(null)}>
        {!!importUrl && (
          <SpotifyImportScreen
            url={importUrl}
            onClose={() => setImportUrl(null)}
            onPlay={play}
          />
        )}
      </Modal>

      <Modal
        visible={settingsOpen}
        animationType="slide"
        onRequestClose={() => setSettingsOpen(false)}>
        <SettingsScreen onClose={() => setSettingsOpen(false)} />
      </Modal>

      <AddToPlaylistSheet track={addTo} onClose={() => setAddTo(null)} />

      {engine && (
        <PlayerScreen
          visible={playerOpen}
          onClose={() => setPlayerOpen(false)}
          onAddToPlaylist={setAddTo}
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
