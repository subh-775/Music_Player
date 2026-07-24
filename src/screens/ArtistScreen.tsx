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
import {ChevronLeft, Pause, Play} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {getArtist, type ArtistProfile, type Track} from '../backend';
import {normalizeTracks} from '../tracks';
import {TrackRow} from '../components/TrackRow';
import {useFollowedArtists} from '../artists';
import {
  State,
  togglePlay,
  useActiveTrack,
  usePlaybackState,
} from '../player';

/** Profiles the session has already opened — going back to an artist you just
 *  visited must not spin a loader again. */
const profileCache = new Map<string, ArtistProfile>();

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
  onOpenAlbum,
  onToggleFollow,
}: {
  name: string;
  onClose: () => void;
  onPlay: (track: Track, context: Track[]) => void;
  onMenu: (track: Track) => void;
  onOpenAlbum: (albumName: string, artistName: string) => void;
  onToggleFollow: (name: string, image?: string) => void;
}) {
  const cachedProfile = profileCache.get(name.toLowerCase()) ?? null;
  const [profile, setProfile] = useState<ArtistProfile | null>(cachedProfile);
  const [busy, setBusy] = useState(!cachedProfile);

  // Subscribed to the store, so tapping Follow flips the button IMMEDIATELY —
  // a prop computed once by the parent went stale until something else
  // re-rendered.
  const followed = useFollowedArtists();
  const following = followed.some(
    a => a.name.toLowerCase() === (profile?.name || name).toLowerCase(),
  );

  useEffect(() => {
    if (profileCache.has(name.toLowerCase())) {
      return;
    }
    let alive = true;
    setBusy(true);
    getArtist(name)
      .then(p => {
        profileCache.set(name.toLowerCase(), p);
        if (alive) {
          setProfile(p);
        }
      })
      .catch(() => alive && setProfile(null))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [name]);

  const songs = normalizeTracks(profile?.top_songs ?? []);
  const albums = profile?.albums ?? [];
  const listeners = compact(profile?.listeners ?? profile?.followers);

  // Green button mirrors reality: pause icon while one of this artist's top
  // songs is what's playing, and tapping it pauses/resumes instead of
  // restarting from the top.
  const activeEngine = useActiveTrack();
  const {state: playState} = usePlaybackState() as {state?: State};
  const playingHere = (() => {
    if (!activeEngine) {
      return false;
    }
    const at = String(activeEngine.title ?? '').toLowerCase();
    const aa = String(activeEngine.artist ?? '').toLowerCase();
    return songs.some(
      t => (t.title || '').toLowerCase() === at && (t.artist || '').toLowerCase() === aa,
    );
  })();
  const isPlaying =
    playState === State.Playing ||
    playState === State.Buffering ||
    playState === State.Loading;

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

            <View style={styles.headActions}>
            <TouchableOpacity
              onPress={() => onToggleFollow(profile?.name || name, profile?.image)}
              activeOpacity={0.7}
              style={[styles.follow, following && styles.followOn]}>
              <Text style={[styles.followText, following && styles.followTextOn]}>
                {following ? 'Following' : 'Follow'}
              </Text>
            </TouchableOpacity>
            {songs.length > 0 && (
              <TouchableOpacity
                style={styles.playBtn}
                activeOpacity={0.85}
                onPress={() =>
                  playingHere ? togglePlay().catch(() => {}) : onPlay(songs[0], songs)
                }>
                {playingHere && isPlaying ? (
                  <Pause size={26} color={C.bg} fill={C.bg} />
                ) : (
                  <Play size={26} color={C.bg} fill={C.bg} style={styles.playNudge} />
                )}
              </TouchableOpacity>
            )}
            </View>
          </View>

          {songs.length > 0 && (
            <>
              <Text style={styles.section}>Popular</Text>
              {songs.slice(0, 10).map((t, i) => (
                <TrackRow
                  key={`${t.title}-${i}`}
                  track={t}
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
                  <TouchableOpacity
                    style={styles.album}
                    activeOpacity={0.75}
                    onPress={() => onOpenAlbum(item.name, profile?.name || name)}>
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
                  </TouchableOpacity>
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
  headActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginTop: 16,
  },
  follow: {
    paddingHorizontal: 20,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: C.sub,
  },
  followOn: {borderColor: C.accent},
  followText: {...T.sub, color: C.text, fontWeight: '700'},
  followTextOn: {color: C.accent},
  playBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
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
