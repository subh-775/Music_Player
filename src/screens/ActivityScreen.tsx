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
import {TrackRow, listWindowing} from '../components/TrackRow';
import {useStats, useWeek, type WeekStat} from '../stats';
import type {Track} from '../backend';
import {getTrackId} from '../tracks';

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
  const week = useWeek();

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
          week={week}
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
      keyExtractor={t => getTrackId(t)}
      {...listWindowing}
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

/** "4h 12m", "38m", or "—" when there is nothing yet. */
function duration(minutes: number): string {
  if (minutes <= 0) {
    return '0m';
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** Whatever the backend calls a source, in the app's own words. */
const SOURCE_LABEL: Record<string, string> = {
  jiosaavn: 'JioSaavn',
  youtube: 'YouTube',
  soundcloud: 'SoundCloud',
  itunes: 'iTunes',
  downloads: 'Downloads',
  unknown: 'Other',
};

/**
 * The last seven days: how long, how many, when, and from where.
 *
 * All four read the same play log, so they can never disagree with each other —
 * which is the failure mode of showing four numbers that were each counted
 * separately.
 */
function ThisWeek({week}: {week: WeekStat}) {
  const busiest = Math.max(1, ...week.perDay);
  return (
    <View style={styles.week}>
      <View style={styles.weekHead}>
        <View>
          <Text style={styles.weekNum}>{duration(week.minutes)}</Text>
          <Text style={styles.weekLabel}>of music this week</Text>
        </View>
        {/* Seven bars, oldest left. Deliberately unlabelled: the shape is the
            information, and seven day letters at this size is clutter. */}
        <View style={styles.bars}>
          {week.perDay.map((n, i) => (
            <View key={i} style={styles.barSlot}>
              <View
                style={[
                  styles.dayBar,
                  {height: Math.max(3, (n / busiest) * 34)},
                  i === 6 && styles.dayToday,
                ]}
              />
            </View>
          ))}
        </View>
      </View>

      <Text style={styles.weekSub}>
        {week.songs} song{week.songs === 1 ? '' : 's'} played
      </Text>

      {week.sources.length > 0 && (
        <View style={styles.sources}>
          {week.sources.slice(0, 4).map(src => (
            <View key={src.name} style={styles.sourceRow}>
              <Text style={styles.sourceName} numberOfLines={1}>
                {SOURCE_LABEL[src.name] ?? src.name}
              </Text>
              <View style={styles.sourceTrack}>
                <View
                  style={[
                    styles.sourceFill,
                    {width: `${Math.max(2, src.share * 100)}%`},
                  ]}
                />
              </View>
              <Text style={styles.sourcePct}>
                {Math.round(src.share * 100)}%
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function YourSound({
  topTracks,
  topArtists,
  plays,
  week,
  onPlay,
  onMenu,
  onOpenArtist,
}: {
  topTracks: {track: Track; count: number}[];
  topArtists: {name: string; image?: string; count: number}[];
  plays: number;
  week: WeekStat;
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
      <ThisWeek week={week} />

      <View style={styles.tally}>
        <Text style={styles.tallyNum}>{plays}</Text>
        <Text style={styles.tallyLabel}>
          song{plays === 1 ? '' : 's'} played on this phone, all time
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
  tally: {paddingHorizontal: S.gutter, paddingTop: 18, paddingBottom: 4},
  // Smaller than it was: the week above is now the headline, and two 40px
  // numbers stacked would fight each other for it.
  tallyNum: {color: C.text, fontSize: 26, fontWeight: '800'},
  tallyLabel: {color: C.sub, fontSize: 12.5, marginTop: 2},
  week: {
    marginHorizontal: S.gutter,
    marginTop: 8,
    padding: 16,
    borderRadius: 14,
    backgroundColor: C.surface,
  },
  weekHead: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  weekNum: {color: C.accent, fontSize: 34, fontWeight: '800'},
  weekLabel: {color: C.sub, fontSize: 12.5, marginTop: 1},
  weekSub: {color: C.faint, fontSize: 12, marginTop: 10},
  bars: {flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 34},
  barSlot: {justifyContent: 'flex-end', height: 34},
  dayBar: {width: 7, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.20)'},
  dayToday: {backgroundColor: C.accent},
  sources: {marginTop: 14, gap: 7},
  sourceRow: {flexDirection: 'row', alignItems: 'center', gap: 9},
  sourceName: {color: C.sub, fontSize: 12, width: 78},
  sourceTrack: {
    flex: 1,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.10)',
    overflow: 'hidden',
  },
  sourceFill: {height: '100%', borderRadius: 3, backgroundColor: C.accent},
  sourcePct: {
    color: C.faint,
    fontSize: 11,
    width: 32,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
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
