import React, {useCallback, useEffect, useState} from 'react';
import {
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
import {PlayerScreen} from './src/screens/PlayerScreen';
import {PlayerBar} from './src/components/PlayerBar';
import {C, S, T} from './src/theme';
import {type HomeItem, type Track} from './src/backend';
import {playTrack, setupPlayer} from './src/player';

type Tab = 'home' | 'search' | 'library' | 'settings';

const TABS: {key: Tab; label: string}[] = [
  {key: 'home', label: 'Home'},
  {key: 'search', label: 'Search'},
  {key: 'library', label: 'Library'},
  {key: 'settings', label: 'Settings'},
];

function Shell() {
  const [tab, setTab] = useState<Tab>('home');
  const [collection, setCollection] = useState<HomeItem | null>(null);
  const [playerOpen, setPlayerOpen] = useState(false);
  // null = not yet determined, false = this APK has no native audio engine.
  const [engine, setEngine] = useState<boolean | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setupPlayer().then(setEngine);
  }, []);

  const play = useCallback(async (track: Track) => {
    try {
      await playTrack(track);
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
        {tab === 'library' && <LibraryScreen onPickTrack={play} />}
        {tab === 'settings' && <SettingsScreen />}
      </View>

      {/* Shown only when playback genuinely isn't available, so it can't be
          mistaken for a normal part of the UI. */}
      {!!notice && (
        <TouchableOpacity style={styles.notice} onPress={() => setNotice('')}>
          <Text style={styles.noticeText}>{notice}</Text>
        </TouchableOpacity>
      )}

      {engine && <PlayerBar onExpand={() => setPlayerOpen(true)} />}

      <View style={styles.tabs}>
        {TABS.map(t => (
          <TouchableOpacity
            key={t.key}
            style={styles.tab}
            activeOpacity={0.7}
            onPress={() => setTab(t.key)}>
            <Text
              style={[styles.tabText, tab === t.key && styles.tabTextActive]}>
              {t.label}
            </Text>
            {tab === t.key && <View style={styles.tabMark} />}
          </TouchableOpacity>
        ))}
      </View>

      <CollectionScreen
        item={collection}
        onClose={() => setCollection(null)}
        onPickTrack={play}
      />

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
  tabs: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: C.border,
    backgroundColor: C.bg,
  },
  tab: {flex: 1, alignItems: 'center', paddingVertical: 11, gap: 5},
  tabText: {...T.sub, color: C.faint},
  tabTextActive: {color: C.text},
  tabMark: {width: 14, height: 2, borderRadius: 2, backgroundColor: C.accent},
});
