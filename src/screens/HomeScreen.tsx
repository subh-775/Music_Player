import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {C, S, T} from '../theme';
import {getHome, waitForBackend, type HomeItem, type HomeRow} from '../backend';

type Props = {onPickTrack: (item: HomeItem) => void};

export function HomeScreen({onPickTrack}: Props) {
  const [rows, setRows] = useState<HomeRow[]>([]);
  const [phase, setPhase] = useState<'boot' | 'ready' | 'error'>('boot');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (!isRefresh) {
      setPhase('boot');
    }
    setError('');
    try {
      if (!(await waitForBackend())) {
        throw new Error('The music engine did not start.');
      }
      setRows(await getHome());
      setPhase('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }, [load]);

  if (phase === 'boot') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={C.accent} size="large" />
        <Text style={styles.centerText}>Starting the music engine…</Text>
      </View>
    );
  }

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

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={refresh}
          tintColor={C.accent}
          colors={[C.accent]}
        />
      }>
      <Text style={styles.title}>Home</Text>
      {rows.map(row => (
        <Row key={row.title} row={row} onPick={onPickTrack} />
      ))}
      <View style={styles.tail} />
    </ScrollView>
  );
}

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
        keyExtractor={(_, i) => String(i)}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rowList}
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
          <Image source={{uri: item.image}} style={styles.art} />
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

const styles = StyleSheet.create({
  scroll: {paddingBottom: 24},
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
  centerText: {color: C.sub, fontSize: 14},
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
