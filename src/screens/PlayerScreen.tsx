/**
 * The full-screen player.
 *
 * Layout, top to bottom — this ordering is deliberate and matches the WebView
 * build it replaces:
 *
 *   ⌄            ALBUM NAME (or "Now playing")
 *   [ artwork / lyrics / queue pane ]
 *   Title                              ⊕  ♥  ⭳
 *   Artists · source badge · quality badge
 *   ───────────────── seek ─────────────────
 *   0:42                                3:57
 *   (Song) (Lyrics) (Queue)        ᛒ Buds 2r
 *   ⇄     ⏮        ▶        ⏭      ↻
 *
 * The pane toggles sit ABOVE the transport rather than in the header, so the
 * play controls never move when you switch panes.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  Modal,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  Bluetooth,
  Check,
  ChevronDown,
  DownloadCloud,
  Heart,
  ListMusic,
  Music,
  Pause,
  Play,
  Plus,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Type,
} from 'lucide-react-native';
import {C, T} from '../theme';
import {getLyrics, startDownload, type Lyrics, type Track} from '../backend';
import {cleanText, getBestArtworkUrl, splitArtists} from '../tracks';
import {
  RepeatMode,
  State,
  seekTo,
  setRepeat,
  shuffleQueue,
  skipNext,
  skipPrevious,
  sourceTrackFor,
  togglePlay,
  useActiveTrack,
  usePlaybackState,
  useProgress,
} from '../player';
import {useLike} from '../store';
import {useAudioOutput} from '../audioOutput';
import {QualityBadge, SourceBadge} from '../components/Badges';
import {Seekbar} from '../components/Seekbar';
import {SeekPeek} from '../components/SeekPeek';
import {QueuePane} from './QueueScreen';
import {toast} from '../toast';

const SWIPE_COMMIT = 64; // px before a swipe actually changes track

const PANES = [
  {id: 'song', label: 'Song', Icon: Music},
  {id: 'lyrics', label: 'Lyrics', Icon: Type},
  {id: 'queue', label: 'Queue', Icon: ListMusic},
] as const;

type Pane = (typeof PANES)[number]['id'];

export function PlayerScreen({
  visible,
  onClose,
  onAddToPlaylist,
  onOpenArtist,
}: {
  visible: boolean;
  onClose: () => void;
  onAddToPlaylist: (track: Track) => void;
  onOpenArtist: (credit: string) => void;
}) {
  const active = useActiveTrack();
  const {state} = usePlaybackState() as {state?: State};
  const {position, duration} = useProgress(500);
  const output = useAudioOutput();

  // The engine's queue item is a reduced shape; the badges, download and like
  // all need the real backend Track behind it.
  const track = useMemo(() => sourceTrackFor(active), [active]);
  const {liked, toggle: toggleLike} = useLike(track);

  const [pane, setPane] = useState<Pane>('song');
  const [repeat, setRepeatState] = useState<RepeatMode>(RepeatMode.Off);
  const [shuffled, setShuffled] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Double-tap seek: consecutive taps on the same side stack (10s, 20s, 30s…),
  // the way YouTube does, so a quick triple-tap jumps further.
  const [seekFlash, setSeekFlash] = useState<{
    side: 1 | -1;
    secs: number;
    nonce: number;
  } | null>(null);
  const tapRef = useRef<{t: number; side: 1 | -1; secs: number} | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doubleTapSeek = useCallback(
    (side: 1 | -1) => {
      const now = Date.now();
      const prev = tapRef.current;
      const stacked =
        prev && prev.side === side && now - prev.t < 900 ? prev.secs + 10 : 10;
      tapRef.current = {t: now, side, secs: stacked};

      seekTo(Math.max(0, position + side * stacked));
      // nonce changes every tap, which is what replays the animation when the
      // side and the total happen to be unchanged.
      setSeekFlash({side, secs: stacked, nonce: now});
      if (flashTimer.current) {
        clearTimeout(flashTimer.current);
      }
      flashTimer.current = setTimeout(() => setSeekFlash(null), 800);
    },
    [position],
  );

  useEffect(
    () => () => {
      if (flashTimer.current) {
        clearTimeout(flashTimer.current);
      }
    },
    [],
  );

  // Artwork follows the finger, then leaves and re-enters on a change.
  const slide = useRef(new Animated.Value(0)).current;

  const commit = useCallback(
    (dir: 'next' | 'prev') => {
      Animated.timing(slide, {
        toValue: dir === 'next' ? -400 : 400,
        duration: 180,
        useNativeDriver: true,
      }).start(() => {
        (dir === 'next' ? skipNext() : skipPrevious()).finally(() => {
          slide.setValue(dir === 'next' ? 400 : -400);
          Animated.timing(slide, {
            toValue: 0,
            duration: 260,
            useNativeDriver: true,
          }).start();
        });
      });
    },
    [slide],
  );

  const pan = useMemo(
    () =>
      PanResponder.create({
        // Claim the gesture only once it's clearly horizontal, so a vertical
        // drag still belongs to the scroll/dismiss behaviour.
        onMoveShouldSetPanResponder: (_e, g) =>
          Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderMove: (_e, g) => slide.setValue(g.dx * 0.55),
        onPanResponderRelease: (_e, g) => {
          if (g.dx <= -SWIPE_COMMIT) {
            commit('next');
          } else if (g.dx >= SWIPE_COMMIT) {
            commit('prev');
          } else {
            Animated.spring(slide, {
              toValue: 0,
              useNativeDriver: true,
              bounciness: 6,
            }).start();
          }
        },
      }),
    [slide, commit],
  );

  const cycleRepeat = useCallback(() => {
    const next =
      repeat === RepeatMode.Off
        ? RepeatMode.Queue
        : repeat === RepeatMode.Queue
        ? RepeatMode.Track
        : RepeatMode.Off;
    setRepeatState(next);
    setRepeat(next).catch(() => {});
  }, [repeat]);

  const onShuffle = useCallback(() => {
    shuffleQueue()
      .then(() => {
        setShuffled(v => !v);
        toast('Shuffled what comes next');
      })
      .catch(() => {});
  }, []);

  const download = useCallback(async () => {
    if (!track || downloading) {
      return;
    }
    setDownloading(true);
    try {
      await startDownload(track);
      toast(`Downloading "${cleanText(track.title)}"`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not start that download');
    } finally {
      setDownloading(false);
    }
  }, [track, downloading]);

  if (!active) {
    return null;
  }

  const playing = state === State.Playing;
  const busy = state === State.Buffering || state === State.Loading;
  const artwork = track ? getBestArtworkUrl(track) : String(active.artwork ?? '');
  const title = cleanText(String(active.title ?? ''));
  const artists = splitArtists(String(active.artist ?? '')).join(', ');
  const album = track?.album ? cleanText(track.album) : '';

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent>
      <View style={styles.wrap}>
        {/* Header — close on the left, what you're inside of in the middle. */}
        <View style={styles.topBar}>
          <TouchableOpacity onPress={onClose} hitSlop={14} style={styles.iconBtn}>
            <ChevronDown size={26} color={C.text} />
          </TouchableOpacity>
          <Text style={styles.context} numberOfLines={1}>
            {album || 'Now playing'}
          </Text>
          {/* Balances the close button so the label stays centred. */}
          <View style={styles.iconBtn} />
        </View>

        {/* The only flexible row: it shrinks and scrolls rather than pushing
            the controls below the fold. */}
        <View style={styles.pane}>
          {pane === 'lyrics' && (
            <LyricsPane
              title={title}
              artist={String(active.artist ?? '')}
              durationMs={duration ? duration * 1000 : undefined}
              position={position}
            />
          )}
          {pane === 'queue' && <QueuePane />}
          {pane === 'song' && (
            <View style={styles.artArea} {...pan.panHandlers}>
              <Animated.View
                style={[styles.artHolder, {transform: [{translateX: slide}]}]}
                pointerEvents="none">
                {artwork ? (
                  <Image source={{uri: artwork}} style={styles.art} />
                ) : (
                  <View style={[styles.art, styles.artFallback]} />
                )}
              </Animated.View>

              {/* Double-tap zones over the artwork edges. They claim a TAP
                  only — the swipe responder above still owns any drag. */}
              <View style={styles.tapZones} pointerEvents="box-none">
                <TapZone onDoubleTap={() => doubleTapSeek(-1)} />
                <TapZone onDoubleTap={() => doubleTapSeek(1)} />
              </View>

              {!!seekFlash && (
                <SeekPeek
                  side={seekFlash.side}
                  seconds={seekFlash.secs}
                  nonce={seekFlash.nonce}
                />
              )}
            </View>
          )}
        </View>

        <View style={styles.controls}>
          {/* Title + credits on the left, the three per-song actions right. */}
          <View style={styles.metaRow}>
            <View style={styles.meta}>
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              <View style={styles.creditRow}>
                {/* The WHOLE credit is one target. A single name opens that
                    profile directly; several open the picker. */}
                <TouchableOpacity
                  onPress={() => onOpenArtist(String(active.artist ?? ''))}
                  activeOpacity={0.6}
                  style={styles.artistTap}>
                  <Text style={styles.artist} numberOfLines={1}>
                    {artists}
                  </Text>
                </TouchableOpacity>
                <SourceBadge track={track} />
                <QualityBadge track={track} />
              </View>
            </View>

            <View style={styles.actions}>
              <TouchableOpacity
                onPress={() => track && onAddToPlaylist(track)}
                hitSlop={8}
                style={styles.actionBtn}>
                {/* A 22px ring so the circled + reads the same visual size as
                    the bare heart and download glyphs beside it. */}
                <View style={styles.plusRing}>
                  <Plus size={13} color={C.sub} strokeWidth={2.6} />
                </View>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={toggleLike}
                hitSlop={8}
                style={styles.actionBtn}>
                <Heart
                  size={22}
                  color={liked ? C.accent : C.sub}
                  fill={liked ? C.accent : 'transparent'}
                />
              </TouchableOpacity>

              <TouchableOpacity
                onPress={download}
                disabled={downloading}
                hitSlop={8}
                style={styles.actionBtn}>
                {downloading ? (
                  <Check size={22} color={C.accent} />
                ) : (
                  <DownloadCloud size={22} color={C.sub} />
                )}
              </TouchableOpacity>
            </View>
          </View>

          <Seekbar position={position} duration={duration} onSeek={seekTo} />

          {/* Pane toggles left, audio output right — above the transport so
              the play controls never shift. */}
          <View style={styles.paneRow}>
            <View style={styles.paneTabs}>
              {PANES.map(({id, label, Icon}) => {
                const on = pane === id;
                return (
                  <TouchableOpacity
                    key={id}
                    onPress={() => setPane(id)}
                    activeOpacity={0.8}
                    style={[styles.paneTab, on && styles.paneTabOn]}>
                    <Icon size={15} color={on ? C.text : C.faint} />
                    <Text
                      style={[styles.paneLabel, on && styles.paneLabelOn]}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {!!output && (
              <View style={styles.output}>
                <Bluetooth size={13} color={C.accent} />
                <Text style={styles.outputText} numberOfLines={1}>
                  {output}
                </Text>
              </View>
            )}
          </View>

          {/* Transport */}
          <View style={styles.transport}>
            <TouchableOpacity onPress={onShuffle} hitSlop={10} style={styles.tBtn}>
              <Shuffle size={24} color={shuffled ? C.accent : C.sub} />
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => skipPrevious()}
              hitSlop={10}
              style={styles.tBtn}>
              <SkipBack size={34} color={C.text} fill={C.text} />
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => togglePlay()}
              activeOpacity={0.85}
              style={styles.playBtn}>
              {busy ? (
                <ActivityIndicator color={C.bg} />
              ) : playing ? (
                <Pause size={30} color={C.bg} fill={C.bg} />
              ) : (
                <Play size={30} color={C.bg} fill={C.bg} style={styles.playNudge} />
              )}
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => skipNext()}
              hitSlop={10}
              style={styles.tBtn}>
              <SkipForward size={34} color={C.text} fill={C.text} />
            </TouchableOpacity>

            <TouchableOpacity onPress={cycleRepeat} hitSlop={10} style={styles.tBtn}>
              {repeat === RepeatMode.Track ? (
                <Repeat1 size={24} color={C.accent} />
              ) : (
                <Repeat
                  size={24}
                  color={repeat === RepeatMode.Queue ? C.accent : C.sub}
                />
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** Half the artwork, listening for a double tap only. A single tap is left
 *  alone so it never fights the swipe gesture. */
function TapZone({onDoubleTap}: {onDoubleTap: () => void}) {
  const last = useRef(0);
  return (
    <TouchableOpacity
      style={styles.tapZone}
      activeOpacity={1}
      onPress={() => {
        const now = Date.now();
        if (now - last.current < 300) {
          onDoubleTap();
          last.current = 0;
        } else {
          last.current = now;
        }
      }}
    />
  );
}

const LINE_H = 44;

/**
 * Synced lyrics scroll themselves and can be tapped to jump; plain text is
 * shown when that's all the sources have.
 */
function LyricsPane({
  title,
  artist,
  durationMs,
  position,
}: {
  title: string;
  artist: string;
  durationMs?: number;
  position: number;
}) {
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState('');
  const scroller = useRef<ScrollView>(null);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setErr('');
    setLyrics(null);
    getLyrics(title, artist, durationMs)
      .then(l => alive && setLyrics(l))
      .catch(e => alive && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [title, artist, durationMs]);

  const synced = useMemo(() => lyrics?.synced ?? [], [lyrics]);

  const activeLine = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < synced.length; i++) {
      if (synced[i].time <= position) {
        idx = i;
      } else {
        break;
      }
    }
    return idx;
  }, [synced, position]);

  // Keep the current line around a third of the way down, which is where the
  // eye already is — centring it means constantly reading at the midpoint and
  // losing the lines just sung.
  useEffect(() => {
    if (activeLine < 0 || !scroller.current) {
      return;
    }
    scroller.current.scrollTo({
      y: Math.max(0, activeLine * LINE_H - 120),
      animated: true,
    });
  }, [activeLine]);

  if (busy) {
    return (
      <View style={styles.lyricCenter}>
        <ActivityIndicator color={C.accent} />
      </View>
    );
  }
  if (err || (!synced.length && !lyrics?.plain)) {
    return (
      <View style={styles.lyricCenter}>
        <Text style={styles.lyricEmpty}>No lyrics found for this track.</Text>
      </View>
    );
  }

  return (
    <ScrollView
      ref={scroller}
      style={styles.lyricScroll}
      contentContainerStyle={styles.lyricBody}
      showsVerticalScrollIndicator={false}>
      {synced.length > 0
        ? synced.map((line, i) => (
            <Text
              key={`${line.time}-${i}`}
              onPress={() => seekTo(line.time)}
              style={[styles.lyricLine, i === activeLine && styles.lyricLineOn]}>
              {line.text || '♪'}
            </Text>
          ))
        : (lyrics?.plain || '').split('\n').map((line, i) => (
            <Text key={i} style={styles.lyricPlain}>
              {line || ' '}
            </Text>
          ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1, backgroundColor: C.bg, paddingTop: 8},
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 48,
    paddingHorizontal: 12,
  },
  iconBtn: {width: 30, alignItems: 'flex-start'},
  context: {
    flex: 1,
    textAlign: 'center',
    color: C.sub,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },

  pane: {flex: 1, minHeight: 0},
  artArea: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24},
  artHolder: {width: '100%', aspectRatio: 1, maxHeight: '100%'},
  art: {width: '100%', height: '100%', borderRadius: 8, backgroundColor: C.surface},
  artFallback: {backgroundColor: C.surfaceHi},
  tapZones: {...StyleSheet.absoluteFillObject, flexDirection: 'row'},
  tapZone: {flex: 1},

  controls: {paddingHorizontal: 24, paddingTop: 12, paddingBottom: 34},
  metaRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 12},
  meta: {flex: 1, minWidth: 0},
  title: {fontSize: 20, fontWeight: '800', color: C.text, letterSpacing: -0.3},
  creditRow: {flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 3},
  artistTap: {flexShrink: 1, minWidth: 0},
  artist: {...T.sub, color: C.sub, fontSize: 13},
  actions: {flexDirection: 'row', alignItems: 'center', gap: 2, paddingTop: 2},
  actionBtn: {padding: 7},
  plusRing: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: C.sub,
    alignItems: 'center',
    justifyContent: 'center',
  },


  paneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 14,
  },
  paneTabs: {flexDirection: 'row', gap: 6},
  paneTab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  paneTabOn: {backgroundColor: 'rgba(255,255,255,0.14)'},
  paneLabel: {fontSize: 11, fontWeight: '600', color: C.faint},
  paneLabelOn: {color: C.text},
  output: {flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1},
  outputText: {color: C.accent, fontSize: 11, fontWeight: '600'},

  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 18,
  },
  tBtn: {padding: 6},
  playBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: C.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playNudge: {marginLeft: 3},

  lyricScroll: {flex: 1},
  lyricBody: {paddingHorizontal: 26, paddingVertical: 20},
  lyricCenter: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  lyricEmpty: {color: C.faint, fontSize: 13},
  lyricLine: {
    fontSize: 21,
    lineHeight: LINE_H,
    fontWeight: '800',
    color: 'rgba(255,255,255,0.38)',
  },
  lyricLineOn: {color: C.text},
  lyricPlain: {fontSize: 16, lineHeight: 26, color: 'rgba(255,255,255,0.8)'},
});
