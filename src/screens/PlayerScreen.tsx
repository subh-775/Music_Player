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
  Dimensions,
  Easing,
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
  CircleArrowDown,
  CirclePlus,
  Heart,
  ListMusic,
  Music,
  Pause,
  Play,
  Repeat2,
  Shuffle,
  SkipBack,
  SkipForward,
  Type,
} from 'lucide-react-native';
import {C, T} from '../theme';
import {getLyrics, type Lyrics, type Track} from '../backend';
import {enqueueDownload, isDownloaded, useDownloadedIds} from '../downloads';
import {cleanText, getBestArtworkUrl, splitArtists} from '../tracks';
import {
  RepeatMode,
  seekTo,
  setRepeat,
  setShuffle,
  skipNext,
  skipPrevious,
  sourceTrackFor,
  togglePlay,
  useActiveTrack,
  useIsPlaying,
  useProgress,
} from '../player';
import {useLike} from '../store';
import {useAudioOutput} from '../audioOutput';
import {toward, useArtworkColor} from '../artworkColor';
import {QualityBadge, SourceBadge} from '../components/Badges';
import {Seekbar} from '../components/Seekbar';
import {SeekPeek} from '../components/SeekPeek';
import {QueuePane} from './QueueScreen';
import {Toaster} from '../components/Toaster';
import {toast} from '../toast';

/** Full sheet travel for the open/close slide. */
const SCREEN_H = Dimensions.get('window').height;

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
  const playing = useIsPlaying();
  const {position, duration} = useProgress(500);
  const output = useAudioOutput();

  // The engine's queue item is a reduced shape; the badges, download and like
  // all need the real backend Track behind it.
  const track = useMemo(() => sourceTrackFor(active), [active]);
  const {liked, toggle: toggleLike} = useLike(track);

  // The screen takes on the song's colour, darkened hard enough that every
  // label keeps contrast. Falls back to plain black when unknown.
  const tint = useArtworkColor(
    track ? getBestArtworkUrl(track) : String(active?.artwork ?? '') || undefined,
  );

  const [pane, setPane] = useState<Pane>('song');
  const [repeat, setRepeatState] = useState<RepeatMode>(RepeatMode.Off);
  const [shuffled, setShuffled] = useState(false);
  const [downloading, setDownloading] = useState(false);
  // Subscribed so the button flips to the green tick the moment the download
  // completes, and stays a tick on a song that's already on disk.
  useDownloadedIds();
  const downloaded = isDownloaded(track);

  // Double-tap seek: consecutive taps on the same side stack (10s, 20s, 30s…),
  // the way YouTube does, so a quick triple-tap jumps further.
  const [seekFlash, setSeekFlash] = useState<{
    side: 1 | -1;
    secs: number;
  } | null>(null);
  const tapRef = useRef<{t: number; side: 1 | -1; secs: number} | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doubleTapSeek = useCallback(
    (side: 1 | -1) => {
      const target = position + side * 10;
      // Dashing PAST the ends changes the song — and a track change from a
      // deliberate gesture should always PLAY, even if you were paused. (Seeking
      // WITHIN a song leaves play/pause alone, so scrubbing a paused song stays
      // paused.) skipNext/skipPrevious both resume.
      if (side === 1 && duration > 0 && target >= duration - 0.5) {
        setSeekFlash(null);
        tapRef.current = null;
        skipNext();
        return;
      }
      if (side === -1 && position <= 0.5) {
        setSeekFlash(null);
        tapRef.current = null;
        skipPrevious();
        return;
      }

      const now = Date.now();
      const prev = tapRef.current;
      const stacked =
        prev && prev.side === side && now - prev.t < 900 ? prev.secs + 10 : 10;
      tapRef.current = {t: now, side, secs: stacked};

      seekTo(Math.max(0, position + side * stacked));
      // The disc holds steady while it's up; only the number changes here.
      setSeekFlash({side, secs: stacked});
      if (flashTimer.current) {
        clearTimeout(flashTimer.current);
      }
      flashTimer.current = setTimeout(() => setSeekFlash(null), 800);
    },
    [position, duration],
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

  /**
   * The sheet's own position. The Modal no longer animates itself.
   *
   * With `animationType="slide"`, releasing a drag called onClose() and the
   * Modal restarted its OWN slide from the top — ignoring where the finger had
   * dragged to. That restart is the hitch: the sheet jumped back up and then
   * slid away. Now the drag, the fling and the button all move this one value,
   * so a dismiss simply carries on from wherever the sheet already is.
   *
   * Safe to drive ourselves only because the Modal is `transparent`; an opaque
   * one showed white behind the translated content.
   */
  const sheetY = useRef(new Animated.Value(SCREEN_H)).current;

  useEffect(() => {
    if (!visible) {
      return;
    }
    sheetY.setValue(SCREEN_H);
    Animated.timing(sheetY, {
      toValue: 0,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, sheetY]);

  const springBack = useCallback(() => {
    Animated.spring(sheetY, {
      toValue: 0,
      useNativeDriver: true,
      bounciness: 4,
    }).start();
  }, [sheetY]);

  /** Slide the rest of the way out, THEN unmount — no restart, no jump. */
  const close = useCallback(
    (velocity = 0) => {
      Animated.timing(sheetY, {
        toValue: SCREEN_H,
        // A firm flick finishes quicker than a slow drag, so the sheet keeps
        // the speed the finger gave it instead of always taking the same time.
        duration: velocity > 1.5 ? 150 : 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(({finished}) => {
        if (finished) {
          onClose();
        }
      });
    },
    [sheetY, onClose],
  );

  const dismissPan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) =>
          g.dy > 8 && g.dy > Math.abs(g.dx) * 1.5,
        onPanResponderMove: (_e, g) => {
          if (g.dy > 0) {
            sheetY.setValue(g.dy);
          }
        },
        onPanResponderRelease: (_e, g) => {
          if (g.dy > 120 || g.vy > 0.8) {
            close(g.vy);
          } else {
            springBack();
          }
        },
        onPanResponderTerminate: springBack,
      }),
    [sheetY, close, springBack],
  );

  const commit = useCallback(
    (dir: 'next' | 'prev') => {
      // Fire the skip IMMEDIATELY so the engine advances during the animation,
      // not after it — that lag was the "old song lingers, then flips" bug.
      (dir === 'next' ? skipNext() : skipPrevious()).catch(() => {});
      Animated.timing(slide, {
        toValue: dir === 'next' ? -400 : 400,
        duration: 160,
        useNativeDriver: true,
      }).start(() => {
        slide.setValue(dir === 'next' ? 400 : -400);
        Animated.timing(slide, {
          toValue: 0,
          duration: 240,
          useNativeDriver: true,
        }).start();
      });
    },
    [slide],
  );

  // The artwork owns TWO gestures: swipe LEFT/RIGHT to change song, and swipe
  // DOWN to dismiss — so the down-swipe works from the big artwork, not only the
  // little header. The axis is locked on the first clear movement.
  const artAxis = useRef<'h' | 'v' | null>(null);
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) =>
          (Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.4) ||
          (g.dy > 8 && g.dy > Math.abs(g.dx) * 1.4),
        onPanResponderGrant: () => {
          artAxis.current = null;
        },
        onPanResponderMove: (_e, g) => {
          if (!artAxis.current) {
            artAxis.current =
              Math.abs(g.dx) > Math.abs(g.dy) ? 'h' : 'v';
          }
          if (artAxis.current === 'h') {
            slide.setValue(g.dx * 0.55);
          } else if (g.dy > 0) {
            sheetY.setValue(g.dy);
          }
        },
        onPanResponderRelease: (_e, g) => {
          if (artAxis.current === 'v') {
            if (g.dy > 120 || g.vy > 0.8) {
              onClose();
            } else {
              springBack();
            }
            return;
          }
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
        onPanResponderTerminate: () => {
          springBack();
          Animated.spring(slide, {toValue: 0, useNativeDriver: true}).start();
        },
      }),
    [slide, sheetY, commit, onClose, springBack],
  );

  /**
   * Repeat is a two-state switch: off, or repeat THIS song.
   *
   * Track mode loops the current song when it ends — dominating shuffle and
   * autoplay, which is what "replay" means here — while the skip button still
   * moves to the next song manually (RNTP's skipToNext ignores repeat mode).
   */
  const toggleRepeat = useCallback(() => {
    const next = repeat === RepeatMode.Off ? RepeatMode.Track : RepeatMode.Off;
    setRepeatState(next);
    setRepeat(next).catch(() => {});
  }, [repeat]);

  // Guard against mashing: one shuffle + one toast per ~1.2s, so a rapid series
  // of taps doesn't spam the notice or re-toggle the icon on every press.
  const shuffleLock = useRef(0);
  const onShuffle = useCallback(() => {
    const now = Date.now();
    if (now - shuffleLock.current < 800) {
      return;
    }
    shuffleLock.current = now;
    // A real toggle: flip the state, then make the queue match it. OFF restores
    // the original order; ON shuffles. The icon follows `shuffled`.
    setShuffled(prev => {
      const next = !prev;
      setShuffle(next).catch(() => {});
      toast(next ? 'Shuffle on' : 'Shuffle off');
      return next;
    });
  }, []);

  const download = useCallback(async () => {
    if (!track || downloading) {
      return;
    }
    setDownloading(true);
    try {
      await enqueueDownload(track);
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

  const artwork = track ? getBestArtworkUrl(track) : String(active.artwork ?? '');
  const title = cleanText(String(active.title ?? ''));
  const artists = splitArtists(String(active.artist ?? '')).join(', ');
  const album = track?.album ? cleanText(track.album) : '';

  return (
    <Modal
      visible={visible}
      animationType="none"
      // Transparent so that when the swipe drags the sheet DOWN, the space it
      // vacates reveals the app behind (Home) instead of the modal window's own
      // white background. The sheet itself is opaque (styles.wrap), so a fully
      // open player still covers everything.
      transparent
      onRequestClose={() => close()}
      statusBarTranslucent>
      <Animated.View
        style={[
          styles.wrap,
          !!tint && {backgroundColor: toward(tint, 0.72)},
          {transform: [{translateY: sheetY}]},
        ]}>
        {/* Header — close on the left, what you're inside of in the middle.
            Drag it (or the area around it) DOWN to dismiss, like Spotify. */}
        <View style={styles.topBar} {...dismissPan.panHandlers}>
          <TouchableOpacity
            onPress={() => close()}
            hitSlop={14}
            style={styles.iconBtn}>
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
          {/* Lyrics and queue stay MOUNTED and are shown/hidden — remounting
              re-ran their whole load every pane switch, which is the 1-2s
              "loading again" the pane tabs kept showing. */}
          <View style={pane === 'lyrics' ? styles.paneFill : styles.paneOff}>
            <LyricsPane
              title={title}
              artist={String(active.artist ?? '')}
              durationMs={duration ? duration * 1000 : undefined}
              position={position}
              visible={pane === 'lyrics'}
            />
          </View>
          <View style={pane === 'queue' ? styles.paneFill : styles.paneOff}>
            <QueuePane />
          </View>
          {pane === 'song' && (
            <View style={styles.artArea} {...pan.panHandlers}>
              <Animated.View
                style={[styles.artHolder, {transform: [{translateX: slide}]}]}
                pointerEvents="none">
                {artwork ? (
                  // Keyed by the URL: when the song changes, React swaps in a
                  // FRESH Image rather than reusing the old element (which held
                  // the previous cover visible until the new one decoded — the
                  // "previous artwork for a few ms" flash).
                  <Image key={artwork} source={{uri: artwork}} style={styles.art} />
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
                <SeekPeek side={seekFlash.side} seconds={seekFlash.secs} />
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
              {/* Circled glyphs, matching the reference: ⊕ add, ♥ like,
                  ⬇-in-circle download. */}
              <TouchableOpacity
                onPress={() => track && onAddToPlaylist(track)}
                hitSlop={8}
                style={styles.actionBtn}>
                <CirclePlus size={23} color={C.sub} strokeWidth={1.8} />
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
                disabled={downloading || downloaded}
                hitSlop={8}
                style={styles.actionBtn}>
                {downloaded || downloading ? (
                  <Check size={22} color={C.accent} strokeWidth={2.6} />
                ) : (
                  <CircleArrowDown size={23} color={C.sub} strokeWidth={1.8} />
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
              {playing ? (
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

            <TouchableOpacity onPress={toggleRepeat} hitSlop={10} style={styles.tBtn}>
              <Repeat2
                size={26}
                color={repeat === RepeatMode.Off ? C.sub : C.accent}
                strokeWidth={repeat === RepeatMode.Off ? 2 : 2.4}
              />
            </TouchableOpacity>
          </View>
        </View>

        {/* Toasts must be visible INSIDE this modal — the app-root toaster
            sits underneath it, so "Downloading…" was invisible until the
            player was closed. Same queue, second outlet. */}
        <Toaster bottom={40} />
      </Animated.View>
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

/** Session-lifetime lyrics cache. Keyed on title|artist; capped so a long
 *  session can't hold hundreds of lyric sheets. */
const lyricsCache = new Map<string, Lyrics>();

function trimCache(map: Map<string, unknown>, max = 40): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    map.delete(oldest);
  }
}

/**
 * Synced lyrics scroll themselves and can be tapped to jump; plain text is
 * shown when that's all the sources have.
 */
function LyricsPane({
  title,
  artist,
  durationMs,
  position,
  visible = true,
}: {
  title: string;
  artist: string;
  durationMs?: number;
  position: number;
  /** Mounted-but-hidden panes must not scroll a view nobody can see. */
  visible?: boolean;
}) {
  const cacheKey = `${title}|${artist}`.toLowerCase();
  const cached = lyricsCache.get(cacheKey);
  const [lyrics, setLyrics] = useState<Lyrics | null>(cached ?? null);
  const [busy, setBusy] = useState(!cached);
  const [err, setErr] = useState('');
  const scroller = useRef<ScrollView>(null);

  useEffect(() => {
    // New song, new geometry — stale measurements would centre wrong lines.
    lineTops.current = [];
    // Cached: the pane paints instantly — switching Song → Queue → Lyrics must
    // not re-fetch what was on screen two taps ago.
    const hit = lyricsCache.get(cacheKey);
    if (hit) {
      setLyrics(hit);
      setBusy(false);
      setErr('');
      return;
    }
    let alive = true;
    setBusy(true);
    setErr('');
    setLyrics(null);
    getLyrics(title, artist, durationMs)
      .then(l => {
        lyricsCache.set(cacheKey, l);
        trimCache(lyricsCache);
        if (alive) {
          setLyrics(l);
        }
      })
      .catch(e => alive && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [cacheKey, title, artist, durationMs]);

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

  // MEASURED line positions, not index * LINE_H. Long lines wrap to two or
  // three rows, so the fixed-height guess drifted further with every verse —
  // which is how the sung line ended up above the fold. Each line reports its
  // real y; the scroll centres the active one in the visible pane.
  const lineTops = useRef<number[]>([]);
  const [paneH, setPaneH] = useState(0);

  useEffect(() => {
    if (!visible || activeLine < 0 || !scroller.current) {
      return;
    }
    const y = lineTops.current[activeLine] ?? activeLine * LINE_H;
    scroller.current.scrollTo({
      y: Math.max(0, y - Math.max(90, paneH * 0.4)),
      animated: true,
    });
  }, [activeLine, visible, paneH]);

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
      onLayout={e => setPaneH(e.nativeEvent.layout.height)}
      showsVerticalScrollIndicator={false}>
      {synced.length > 0
        ? synced.map((line, i) => (
            <Text
              key={`${line.time}-${i}`}
              onPress={() => seekTo(line.time)}
              onLayout={e => {
                lineTops.current[i] = e.nativeEvent.layout.y;
              }}
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
  paneFill: {flex: 1, minHeight: 0},
  paneOff: {display: 'none'},
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
  // 10px padding takes the 24px shuffle/repeat icons to a 44px touch target.
  tBtn: {padding: 10},
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
