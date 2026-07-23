import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
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
import {C, S, T} from './src/theme';
import {
  formatDuration,
  getStreamInfo,
  type HomeItem,
  type StreamInfo,
  type Track,
} from './src/backend';

type Tab = 'home' | 'search';

function Shell() {
  const [tab, setTab] = useState<Tab>('home');
  const [selected, setSelected] = useState<Track | null>(null);

  // A Home card can be a track, album or playlist; only tracks carry a payload
  // we can resolve today. Albums/playlists open once their screens exist.
  const pickHomeItem = useCallback((item: HomeItem) => {
    if (item.type === 'track' && item.track) {
      setSelected(item.track);
    }
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <View style={styles.body}>
        {tab === 'home' ? (
          <HomeScreen onPickTrack={pickHomeItem} />
        ) : (
          <SearchScreen onPickTrack={setSelected} />
        )}
      </View>

      <View style={styles.tabs}>
        <TabButton
          label="Home"
          active={tab === 'home'}
          onPress={() => setTab('home')}
        />
        <TabButton
          label="Search"
          active={tab === 'search'}
          onPress={() => setTab('search')}
        />
      </View>

      <TrackSheet track={selected} onClose={() => setSelected(null)} />
    </SafeAreaView>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.tab} onPress={onPress} activeOpacity={0.7}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>
        {label}
      </Text>
      {active && <View style={styles.tabMark} />}
    </TouchableOpacity>
  );
}

/**
 * Tapping a track resolves its real stream URL — the same call playback makes.
 * Until the audio engine ships in the next native build, this is the honest
 * proof that a track is genuinely playable (and surfaces which source served it
 * and at what bitrate).
 */
function TrackSheet({
  track,
  onClose,
}: {
  track: Track | null;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<StreamInfo | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!track) {
      setInfo(null);
      setErr('');
      return;
    }
    let alive = true;
    setBusy(true);
    setInfo(null);
    setErr('');
    getStreamInfo(track)
      .then(res => alive && setInfo(res))
      .catch(e => alive && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [track]);

  if (!track) {
    return null;
  }

  const source = track.playable_source || track.primary_source || 'unknown';
  const dur = formatDuration(track.duration_ms);

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <View style={styles.sheetHead}>
          {track.artwork_url ? (
            <Image source={{uri: track.artwork_url}} style={styles.sheetArt} />
          ) : (
            <View style={[styles.sheetArt, styles.sheetArtFallback]} />
          )}
          <View style={styles.sheetMeta}>
            <Text style={styles.sheetTitle} numberOfLines={2}>
              {track.title}
            </Text>
            <Text style={styles.sheetSub} numberOfLines={1}>
              {track.artist}
              {dur ? `  ·  ${dur}` : ''}
            </Text>
            <Text style={styles.sheetSource}>{source}</Text>
          </View>
        </View>

        <View style={styles.statusBox}>
          {busy && (
            <View style={styles.statusRow}>
              <ActivityIndicator color={C.accent} size="small" />
              <Text style={styles.statusText}>Resolving stream…</Text>
            </View>
          )}
          {!!err && <Text style={styles.statusErr}>{err}</Text>}
          {!!info?.url && (
            <>
              <Text style={styles.statusOk}>
                Stream ready
                {info.bitrate_kbps ? ` · ${info.bitrate_kbps} kbps` : ''}
              </Text>
              <Text style={styles.statusNote}>
                Playback engine arrives in the next build — this confirms the
                track resolves and is genuinely playable.
              </Text>
            </>
          )}
          {!busy && !err && info && !info.url && (
            <Text style={styles.statusErr}>
              {info.error || 'No playable stream for this track.'}
            </Text>
          )}
        </View>

        <TouchableOpacity style={styles.close} onPress={onClose}>
          <Text style={styles.closeText}>Close</Text>
        </TouchableOpacity>
      </View>
    </Modal>
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
  tabs: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: C.border,
    backgroundColor: C.bg,
  },
  tab: {flex: 1, alignItems: 'center', paddingVertical: 12, gap: 5},
  tabText: {...T.body, color: C.faint},
  tabTextActive: {color: C.text},
  tabMark: {width: 16, height: 2, borderRadius: 2, backgroundColor: C.accent},
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.55)'},
  sheet: {
    backgroundColor: C.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: S.gutter,
    paddingBottom: 26,
    gap: 16,
  },
  grabber: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: C.faint,
    marginBottom: 4,
  },
  sheetHead: {flexDirection: 'row', gap: 14},
  sheetArt: {width: 78, height: 78, borderRadius: 8},
  sheetArtFallback: {backgroundColor: C.surfaceHi},
  sheetMeta: {flex: 1, minWidth: 0, justifyContent: 'center', gap: 3},
  sheetTitle: {fontSize: 17, fontWeight: '700', color: C.text},
  sheetSub: {...T.sub, color: C.sub},
  sheetSource: {...T.sub, color: C.accent, marginTop: 2},
  statusBox: {
    backgroundColor: C.surfaceHi,
    borderRadius: S.radius,
    padding: 14,
    gap: 6,
  },
  statusRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  statusText: {color: C.sub, fontSize: 13.5},
  statusOk: {color: '#2bd17e', fontSize: 14, fontWeight: '700'},
  statusErr: {color: C.danger, fontSize: 13.5},
  statusNote: {color: C.sub, fontSize: 12.5, lineHeight: 17},
  close: {alignItems: 'center', paddingVertical: 10},
  closeText: {color: C.sub, fontSize: 14, fontWeight: '600'},
});
