/**
 * The drawer's two listening pages, in one screen because they read the same
 * data and differ only in how it's sorted:
 *
 *   Recents    — everything you've played, newest first
 *   Your sound — the same history counted: top artists, top songs, total plays
 *
 * Both come from stats.ts rather than the 20-entry recently-played row, which
 * is what makes "everything" actually mean everything.
 */
import React from 'react';
import {
  FlatList,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {ChevronLeft} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {TrackRow} from '../components/TrackRow';
import {useStats} from '../stats';
import type {Track} from '../backend';

export type ActivityMode = 'recents' | 'stats';

export function ActivityScreen({
  mode,
  onClose,
  onPlay,
  onMenu,
  onOpenArtist,
}: {
  mode: ActivityMode;
  onClose: () => void;
  onPlay: (track: Track, context: Track[]) => void;
  onMenu: (track: Track) => void;
  onOpenArtist: (name: string) => void;
}) {
  const {topTracks, topArtists, plays} = useStats();

  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.back}>
          <ChevronLeft size={28} color={C.text} />
        </TouchableOpacity>
        <Text style={styles.barTitle}>
          {mode === 'recents' ? 'Recents' : 'Your sound'}
        </Text>
      </View>

      {!plays ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            Play a few songs and this fills itself in.
          </Text>
        </View>
      ) : mode === 'recents' ? (
        <Recents tracks={topTracks} onPlay={onPlay} onMenu={onMenu} />
      ) : (
        <YourSound
          topTracks={topTracks}
          topArtists={topArtists}
          plays={plays}
          onPlay={onPlay}
          onMenu={onMenu}
          onOpenArtist={onOpenArtist}
        />
      )}
    </View>
  );
}

function Recents({
  tracks,
  onPlay,
  onMenu,
}: {
  tracks: {track: Track; last: number}[];
  onPlay: (track: Track, context: Track[]) => void;
  onMenu: (track: Track) => void;
}) {
  // Sorted by when it last played, not by how often — that's the difference
  // between this page and Your sound.
  const list = [...tracks].sort((a, b) => b.last - a.last).map(x => x.track);
  return (
    <FlatList
      data={list}
      keyExtractor={(t, i) => `${t.title}-${t.artist}-${i}`}
      contentContainerStyle={styles.list}
      showsVerticalScrollIndicator={false}
      renderItem={({item}) => (
        <TrackRow
          track={item}
          onPress={() => onPlay(item, list)}
          onMenu={() => onMenu(item)}
        />
      )}
    />
  );
}

function YourSound({
  topTracks,
  topArtists,
  plays,
  onPlay,
  onMenu,
  onOpenArtist,
}: {
  topTracks: {track: Track; count: number}[];
  topArtists: {name: string; image?: string; count: number}[];
  plays: number;
  onPlay: (track: Track, context: Track[]) => void;
  onMenu: (track: Track) => void;
  onOpenArtist: (name: string) => void;
}) {
  const songs = topTracks.slice(0, 25).map(x => x.track);
  return (
    <ScrollView
      contentContainerStyle={styles.list}
      showsVerticalScrollIndicator={false}
      overScrollMode="never"
      bounces={false}>
      <View style={styles.tally}>
        <Text style={styles.tallyNum}>{plays}</Text>
        <Text style={styles.tallyLabel}>
          song{plays === 1 ? '' : 's'} played on this phone
        </Text>
      </View>

      {topArtists.length > 0 && (
        <>
          <Text style={styles.section}>Top artists</Text>
          <FlatList
            horizontal
            data={topArtists.slice(0, 12)}
            keyExtractor={a => a.name}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.strip}
            renderItem={({item, index}) => (
              <TouchableOpacity
                style={styles.artist}
                activeOpacity={0.75}
                onPress={() => onOpenArtist(item.name)}>
                {item.image ? (
                  <Image source={{uri: item.image}} style={styles.pfp} />
                ) : (
                  <View style={[styles.pfp, styles.pfpEmpty]}>
                    <Text style={styles.initial}>
                      {item.name.trim().charAt(0).toUpperCase()}
                    </Text>
                  </View>
                )}
                <Text style={styles.artistName} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.artistRank}>
                  #{index + 1} · {item.count} play{item.count === 1 ? '' : 's'}
                </Text>
              </TouchableOpacity>
            )}
          />
        </>
      )}

      <Text style={styles.section}>On repeat</Text>
      {songs.map((t, i) => (
        <TrackRow
          key={`${t.title}-${t.artist}-${i}`}
          track={t}
          index={i + 1}
          onPress={() => onPlay(t, songs)}
          onMenu={() => onMenu(t)}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1, backgroundColor: C.bg},
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: 12,
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  back: {padding: 4},
  barTitle: {...T.screenTitle, color: C.text, fontSize: 19},
  list: {paddingBottom: 24},
  empty: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  emptyText: {color: C.faint, fontSize: 13.5, textAlign: 'center'},
  tally: {paddingHorizontal: S.gutter, paddingTop: 6, paddingBottom: 4},
  tallyNum: {color: C.accent, fontSize: 40, fontWeight: '800'},
  tallyLabel: {color: C.sub, fontSize: 13, marginTop: 2},
  section: {
    ...T.rowTitle,
    color: C.text,
    fontSize: 16,
    paddingHorizontal: S.gutter,
    paddingTop: 22,
    paddingBottom: 10,
  },
  strip: {paddingHorizontal: S.gutter, gap: 16},
  artist: {width: 88, alignItems: 'center'},
  pfp: {width: 78, height: 78, borderRadius: 39, backgroundColor: C.surface},
  pfpEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.surfaceHi,
  },
  initial: {color: C.faint, fontSize: 27, fontWeight: '700'},
  artistName: {...T.sub, color: C.text, marginTop: 7, textAlign: 'center'},
  artistRank: {color: C.faint, fontSize: 11, marginTop: 2},
});
