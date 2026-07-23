/**
 * An artist's profile: photo, monthly listeners, top songs, and albums.
 *
 * The backend assembles this from several services, so parts can be missing —
 * every section here renders only when it actually has content, rather than
 * showing an empty heading.
 */
import React, {useEffect, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {ChevronLeft, Play} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {getArtist, type ArtistProfile, type Track} from '../backend';
import {normalizeTracks} from '../tracks';
import {TrackRow} from '../components/TrackRow';

function compact(n?: number | null): string {
  if (!n || n <= 0) {
    return '';
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (n >= 1_000) {
    return `${Math.round(n / 1000)}K`;
  }
  return String(n);
}

export function ArtistScreen({
  name,
  onClose,
  onPlay,
  onMenu,
}: {
  name: string;
  onClose: () => void;
  onPlay: (track: Track, context: Track[]) => void;
  onMenu: (track: Track) => void;
}) {
  const [profile, setProfile] = useState<ArtistProfile | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    getArtist(name)
      .then(p => alive && setProfile(p))
      .catch(() => alive && setProfile(null))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [name]);

  const songs = normalizeTracks(profile?.top_songs ?? []);
  const albums = profile?.albums ?? [];
  const listeners = compact(profile?.listeners ?? profile?.followers);

  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.barBtn}>
          <ChevronLeft size={28} color={C.text} />
        </TouchableOpacity>
      </View>

      {busy ? (
        <View style={styles.center}>
          <ActivityIndicator color={C.accent} />
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.body}>
          <View style={styles.head}>
            {profile?.image ? (
              <Image source={{uri: profile.image}} style={styles.pfp} />
            ) : (
              <View style={[styles.pfp, styles.pfpEmpty]}>
                <Text style={styles.initials}>
                  {name.trim().charAt(0).toUpperCase()}
                </Text>
              </View>
            )}
            <Text style={styles.name} numberOfLines={2}>
              {profile?.name || name}
            </Text>
            {!!listeners && (
              <Text style={styles.listeners}>{listeners} listeners</Text>
            )}

            {songs.length > 0 && (
              <TouchableOpacity
                style={styles.playBtn}
                activeOpacity={0.85}
                onPress={() => onPlay(songs[0], songs)}>
                <Play size={26} color={C.bg} fill={C.bg} style={styles.playNudge} />
              </TouchableOpacity>
            )}
          </View>

          {songs.length > 0 && (
            <>
              <Text style={styles.section}>Popular</Text>
              {songs.slice(0, 10).map((t, i) => (
                <TrackRow
                  key={`${t.title}-${i}`}
                  track={t}
                  index={i}
                  onPress={() => onPlay(t, songs)}
                  onMenu={() => onMenu(t)}
                />
              ))}
            </>
          )}

          {albums.length > 0 && (
            <>
              <Text style={styles.section}>Albums</Text>
              <FlatList
                horizontal
                data={albums}
                keyExtractor={(a, i) => `${a.name}-${i}`}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.albums}
                renderItem={({item}) => (
                  <View style={styles.album}>
                    {item.image ? (
                      <Image source={{uri: item.image}} style={styles.albumArt} />
                    ) : (
                      <View style={[styles.albumArt, styles.pfpEmpty]} />
                    )}
                    <Text style={styles.albumName} numberOfLines={2}>
                      {item.name}
                    </Text>
                    {!!item.year && (
                      <Text style={styles.albumYear}>{item.year}</Text>
                    )}
                  </View>
                )}
              />
            </>
          )}

          {!!profile?.bio && (
            <>
              <Text style={styles.section}>About</Text>
              <Text style={styles.bio}>{profile.bio}</Text>
            </>
          )}

          {!songs.length && !albums.length && !profile?.bio && (
            <Text style={styles.empty}>
              Not much is known about this artist yet.
            </Text>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1, backgroundColor: C.bg},
  bar: {flexDirection: 'row', paddingTop: 12, paddingHorizontal: 8},
  barBtn: {padding: 4},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  body: {paddingBottom: 28},
  head: {alignItems: 'center', paddingBottom: 8},
  pfp: {width: 150, height: 150, borderRadius: 75, backgroundColor: C.surface},
  pfpEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.surfaceHi,
  },
  initials: {color: C.faint, fontSize: 44, fontWeight: '700'},
  name: {
    ...T.screenTitle,
    color: C.text,
    marginTop: 16,
    textAlign: 'center',
    paddingHorizontal: S.gutter,
  },
  listeners: {...T.sub, color: C.sub, marginTop: 5},
  playBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
  },
  playNudge: {marginLeft: 3},
  section: {
    ...T.rowTitle,
    color: C.text,
    fontSize: 17,
    paddingHorizontal: S.gutter,
    paddingTop: 22,
    paddingBottom: 6,
  },
  albums: {paddingHorizontal: S.gutter, gap: 14},
  album: {width: 128},
  albumArt: {
    width: 128,
    height: 128,
    borderRadius: 6,
    backgroundColor: C.surface,
  },
  albumName: {...T.sub, color: C.text, marginTop: 7, fontWeight: '600'},
  albumYear: {...T.sub, color: C.faint, marginTop: 2, fontSize: 11.5},
  bio: {
    color: C.sub,
    fontSize: 13.5,
    lineHeight: 21,
    paddingHorizontal: S.gutter,
  },
  empty: {
    color: C.faint,
    textAlign: 'center',
    paddingVertical: 40,
    fontSize: 13,
  },
});
