/**
 * Walking-skeleton screen.
 *
 * Its only job is to prove the architecture end to end on a real device:
 *   RN UI  ->  fetch  ->  embedded Chaquopy/Flask backend  ->  real JioSaavn data
 * plus Metro hot-reload over USB. It is NOT the final UI — Home/Search/Settings/
 * player get rebuilt as native screens once this pipe is green.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  NativeModules,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

const PORT: number = NativeModules.Backend?.port ?? 8771;
const BASE = `http://127.0.0.1:${PORT}`;

type Item = {type: string; title?: string; name?: string; artist?: string};
type Row = {title: string; items: Item[]};

// Poll /health until the backend has finished booting (Chaquopy start + warm-up
// takes a few seconds on a cold launch), giving up after ~30s.
async function waitForBackend(): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        return true;
      }
    } catch {
      // not up yet
    }
    await new Promise(res => setTimeout(res, 500));
  }
  return false;
}

export default function App(): React.JSX.Element {
  const [phase, setPhase] = useState<'booting' | 'loading' | 'ready' | 'error'>(
    'booting',
  );
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setPhase('booting');
    setError('');
    const up = await waitForBackend();
    if (!up) {
      setError('Backend did not answer on ' + BASE);
      setPhase('error');
      return;
    }
    setPhase('loading');
    try {
      const r = await fetch(`${BASE}/api/home?language=hindi,english`);
      const data = await r.json();
      setRows(Array.isArray(data?.rows) ? data.rows : []);
      setPhase('ready');
    } catch (e) {
      setError(String(e));
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />
      <View style={styles.header}>
        <Text style={styles.wordmark}>Music_Player</Text>
        <Text style={styles.sub}>
          native shell · backend :{PORT}
          {phase === 'ready' ? ' · live' : ''}
        </Text>
      </View>

      {phase === 'booting' && <Status label="Starting the music engine…" spin />}
      {phase === 'loading' && <Status label="Loading your feed…" spin />}
      {phase === 'error' && (
        <View style={styles.center}>
          <Text style={styles.errText}>{error}</Text>
          <TouchableOpacity style={styles.retry} onPress={load}>
            <Text style={styles.retryText}>Try again</Text>
          </TouchableOpacity>
        </View>
      )}

      {phase === 'ready' && (
        <ScrollView contentContainerStyle={styles.scroll}>
          {rows.length === 0 && (
            <Text style={styles.sub}>The feed came back empty.</Text>
          )}
          {rows.map((row, i) => (
            <View key={i} style={styles.row}>
              <Text style={styles.rowTitle}>{row.title}</Text>
              {row.items.slice(0, 6).map((it, j) => (
                <Text key={j} style={styles.item} numberOfLines={1}>
                  {it.title || it.name || 'Untitled'}
                  {it.artist ? `  ·  ${it.artist}` : ''}
                </Text>
              ))}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function Status({label, spin}: {label: string; spin?: boolean}) {
  return (
    <View style={styles.center}>
      {spin && <ActivityIndicator color={COLORS.accent} size="large" />}
      <Text style={styles.statusText}>{label}</Text>
    </View>
  );
}

const COLORS = {
  bg: '#0e0f13',
  card: '#16181f',
  text: '#f2f3f5',
  sub: '#8b8f9a',
  accent: '#f5a623', // ember amber — distinct from Fix-Spotify's green
};

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: COLORS.bg},
  header: {paddingTop: 56, paddingHorizontal: 20, paddingBottom: 12},
  wordmark: {
    color: COLORS.text,
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  sub: {color: COLORS.sub, fontSize: 12.5, marginTop: 4},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14},
  statusText: {color: COLORS.sub, fontSize: 14},
  errText: {
    color: '#ff6b6b',
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  retry: {
    backgroundColor: COLORS.accent,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 999,
  },
  retryText: {color: '#0e0f13', fontWeight: '700', fontSize: 13},
  scroll: {paddingHorizontal: 20, paddingBottom: 40},
  row: {marginTop: 22},
  rowTitle: {
    color: COLORS.text,
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 8,
  },
  item: {color: COLORS.sub, fontSize: 14, paddingVertical: 5},
});
