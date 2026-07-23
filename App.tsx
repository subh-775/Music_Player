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
import {LibraryScreen, type OpenList} from './src/screens/LibraryScreen';
import {SettingsScreen} from './src/screens/SettingsScreen';
import {CollectionScreen} from './src/screens/CollectionScreen';
import {TrackListScreen} from './src/screens/TrackListScreen';
import {PlayerScreen} from './src/screens/PlayerScreen';
import {PlayerBar} from './src/components/PlayerBar';
import {BottomNav, type Tab} from './src/components/BottomNav';
import {C, S} from './src/theme';
import {type HomeItem, type Track} from './src/backend';
import {playTrack, setupPlayer} from './src/player';
import {hydrate} from './src/store';

function Shell() {
  const [tab, setTab] = useState<Tab>('home');
  const [collection, setCollection] = useState<HomeItem | null>(null);
  const [list, setList] = useState<OpenList | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);
  // null = not yet determined, false = this APK has no native audio engine.
  const [engine, setEngine] = useState<boolean | null>(null);
  const [notice, setNotice] = useState('');

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

  // A Home card is a track, album or playlist. Tracks play; the other two open.
  const pickHomeItem = useCallback(
    (item: HomeItem) => {
      if (item.type === 'track' && item.track) {
        play(item.track);
        return;
      }
      if (item.perma_url) {
        setCollection(item);
      }
    },
    [play],
  );

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      <View style={styles.body}>
        {tab === 'home' && <HomeScreen onPickTrack={pickHomeItem} />}
        {tab === 'search' && <SearchScreen onPickTrack={play} />}
        {tab === 'library' && (
          <LibraryScreen
            onOpenList={setList}
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

      {engine && <PlayerBar onExpand={() => setPlayerOpen(true)} />}

      <BottomNav active={tab} onChange={setTab} />

      <CollectionScreen
        item={collection}
        onClose={() => setCollection(null)}
        onPickTrack={play}
      />

      <Modal
        visible={!!list}
        animationType="slide"
        onRequestClose={() => setList(null)}>
        {!!list && (
          <TrackListScreen
            title={list.title}
            tracks={list.tracks}
            onClose={() => setList(null)}
            onPickTrack={play}
          />
        )}
      </Modal>

      <Modal
        visible={settingsOpen}
        animationType="slide"
        onRequestClose={() => setSettingsOpen(false)}>
        <SettingsScreen onClose={() => setSettingsOpen(false)} />
      </Modal>

      {engine && (
        <PlayerScreen
          visible={playerOpen}
          onClose={() => setPlayerOpen(false)}
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
