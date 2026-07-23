/**
 * Import a public Spotify playlist or album.
 *
 * Spotify is NOT a playback source. We read its tracklist and re-find each song
 * across JioSaavn / SoundCloud / YouTube, so what comes out is ordinary
 * playable tracks — and saving it creates an ordinary playlist, editable
 * afterwards exactly like one you made yourself. There is only one kind of
 * playlist in this app.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  FlatList,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {Check, ChevronLeft, Play, Plus} from 'lucide-react-native';
import {C, S, T} from '../theme';
import type {Track} from '../backend';
import {cleanText, normalizeTracks} from '../tracks';
import {startImport, useSpotifyImport} from '../spotifyImport';
import {addTracksToPlaylist, createPlaylist} from '../playlists';
import {TrackRow} from '../components/TrackRow';
import {toast} from '../toast';

export function SpotifyImportScreen({
  url,
  onClose,
  onPlay,
}: {
  url: string;
  onClose: () => void;
  onPlay: (track: Track, context: Track[]) => void;
}) {
  // Track WHICH url was saved rather than a bare boolean, so "saved" resets by
  // itself when a different playlist is opened.
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const data = useSpotifyImport();

  useEffect(() => {
    if (url) {
      startImport(url);
    }
  }, [url]);

  // The store can briefly hold the previous url's snapshot for one frame after
  // the url changes; treat a mismatch as "still loading this one".
  const active = data.url === url ? data : null;
  const loading = !active || (!active.finished && !active.error);
  const tracks = normalizeTracks(active?.tracks ?? []);
  const missing = active?.missing ?? [];
  const pct =
    active && active.total > 0
      ? Math.round((active.done / active.total) * 100)
      : 0;
  const saved = savedUrl === url;

  const save = useCallback(() => {
    const pl = createPlaylist(active?.name || 'Spotify playlist');
    if (!pl) {
      return;
    }
    // One write for the whole tracklist rather than N — this can be 100 songs.
    addTracksToPlaylist(pl.id, tracks);
    setSavedUrl(url);
    toast(`Saved "${pl.name}" to your library`);
  }, [active?.name, tracks, url]);

  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.barBtn}>
          <ChevronLeft size={28} color={C.text} />
        </TouchableOpacity>
      </View>

      <View style={styles.header}>
        {/* The cover only appears once we have one — an empty grey square while
            loading reads as a broken image. */}
        {!!active?.image && (
          <Image source={{uri: active.image}} style={styles.cover} />
        )}
        <Text style={styles.name} numberOfLines={2}>
          {loading
            ? cleanText(active?.name) || 'Importing from Spotify…'
            : cleanText(active?.name) || 'Spotify playlist'}
        </Text>
        {!loading && !active?.error && (
          <Text style={styles.sub}>
            {active?.matched} of {active?.total} songs found
          </Text>
        )}
      </View>

      {loading && (
        <View style={styles.center}>
          <View style={styles.barTrack}>
            <View
              style={[
                styles.barFill,
                {width: `${active && active.total > 0 ? pct : 8}%`},
              ]}
            />
          </View>
          <Text style={styles.progress}>
            {active && active.total > 0
              ? `${active.done} of ${active.total} songs`
              : 'Reading the playlist…'}
          </Text>
          <Text style={styles.hint}>
            Finding each song across your music sources. You can keep browsing —
            this carries on in the background.
          </Text>
        </View>
      )}

      {!loading && !!active?.error && (
        <View style={styles.center}>
          <Text style={styles.error}>{active.error}</Text>
          <Text style={styles.hint}>
            The playlist has to be public for this to work.
          </Text>
        </View>
      )}

      {!loading && !active?.error && (
        <>
          <View style={styles.actions}>
            <TouchableOpacity
              onPress={save}
              disabled={saved || !tracks.length}
              activeOpacity={0.8}
              style={[styles.saveBtn, saved && styles.saveBtnDone]}>
              {saved ? (
                <Check size={17} color={C.text} />
              ) : (
                <Plus size={17} color={C.text} />
              )}
              <Text style={styles.saveText}>
                {saved ? 'Saved to library' : 'Add to library'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => tracks.length && onPlay(tracks[0], tracks)}
              disabled={!tracks.length}
              activeOpacity={0.85}
              style={styles.playBtn}>
              <Play size={26} color={C.bg} fill={C.bg} />
            </TouchableOpacity>
          </View>

          <FlatList
            data={tracks}
            keyExtractor={(t, i) => `${t.title}-${i}`}
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
            renderItem={({item}) => (
              <TrackRow track={item} onPress={() => onPlay(item, tracks)} />
            )}
            ListFooterComponent={
              // Be explicit about what didn't come across, rather than quietly
              // shipping a shorter playlist than expected.
              missing.length ? (
                <View style={styles.missing}>
                  <Text style={styles.missingTitle}>
                    Not found ({missing.length})
                  </Text>
                  {missing.map(m => (
                    <Text key={m} style={styles.missingRow} numberOfLines={1}>
                      {m}
                    </Text>
                  ))}
                </View>
              ) : null
            }
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1, backgroundColor: C.bg},
  bar: {flexDirection: 'row', paddingTop: 12, paddingHorizontal: 8},
  barBtn: {padding: 4},
  header: {alignItems: 'center', paddingHorizontal: S.gutter, paddingBottom: 18},
  cover: {width: 144, height: 144, borderRadius: 6, backgroundColor: C.surface},
  name: {
    ...T.screenTitle,
    fontSize: 20,
    color: C.text,
    marginTop: 16,
    textAlign: 'center',
  },
  sub: {...T.sub, color: C.sub, marginTop: 5},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40},
  barTrack: {
    width: '100%',
    maxWidth: 260,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.10)',
    overflow: 'hidden',
  },
  barFill: {height: '100%', borderRadius: 3, backgroundColor: C.accent},
  progress: {
    ...T.body,
    color: C.text,
    marginTop: 12,
    fontVariant: ['tabular-nums'],
  },
  hint: {
    ...T.sub,
    color: C.faint,
    textAlign: 'center',
    marginTop: 10,
    lineHeight: 18,
  },
  error: {color: C.danger, fontSize: 13.5, textAlign: 'center'},
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: S.gutter,
    paddingBottom: 12,
  },
  saveBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 11,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  saveBtnDone: {opacity: 0.6},
  saveText: {...T.body, color: C.text},
  playBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: {paddingBottom: 20},
  missing: {paddingHorizontal: S.gutter, paddingTop: 18},
  missingTitle: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: C.sub,
    paddingVertical: 6,
  },
  missingRow: {...T.sub, color: C.faint, paddingVertical: 3},
});
