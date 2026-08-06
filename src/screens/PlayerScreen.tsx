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
  Info,
  Music,
  Pause,
  Play,
  Repeat2,
  Shuffle,
  SkipBack,
  SkipForward,
  Type,
} from 'lucide-react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {C, T} from '../theme';
import {getLyrics, type Lyrics, type Track} from '../backend';
import {enqueueDownload, isDownloaded, useDownloadedIds} from '../downloads';
import {cleanText, getBestArtworkUrl, splitArtists} from '../tracks';
import {
  RepeatMode,
  isShuffled,
  peekAdjacentTrack,
  seekTo,
  setRepeat,
  setShuffle,
  useShuffle,
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
// How far the artwork (and now the title) travels off-screen on a full swipe.
// Shared so the title tracks the SAME motion the artwork already had — that
// shared number is what makes them move as one thing instead of two.
const ART_TRAVEL = 400;

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
  const {position: enginePosition, duration} = useProgress(250);
  const output = useAudioOutput();

  /**
   * Where the bar should SAY we are.
   *
   * useProgress only samples the engine periodically, so after a double-tap
   * seek the bar sat at the old spot until the next sample landed — the seek
   * felt like it lagged the tap. A seek now publishes its target immediately
   * and that value wins until the engine's own reading catches up to it, at
   * which point the engine is authoritative again.
   */
  const [seekEcho, setSeekEcho] = useState<{at: number; to: number} | null>(
    null,
  );
  const position =
    seekEcho && Math.abs(enginePosition - seekEcho.to) > 1.2 &&
    Date.now() - seekEcho.at < 1500
      ? seekEcho.to
      : enginePosition;

  /** Seek AND move the bar in the same frame. */
  const seekAndShow = useCallback((to: number) => {
    const target = Math.max(0, to);
    setSeekEcho({at: Date.now(), to: target});
    seekTo(target);
  }, []);

  // The engine's queue item is a reduced shape; the badges, download and like
  // all need the real backend Track behind it.
  const track = useMemo(() => sourceTrackFor(active), [active]);
  const {liked, toggle: toggleLike} = useLike(track);

  // The screen takes on the song's colour, darkened hard enough that every
  // label keeps contrast. Falls back to plain black when unknown.
  const tint = useArtworkColor(
    track ? getBestArtworkUrl(track) : String(active?.artwork ?? '') || undefined,
  );

  // Fetched here, not inside the pane: the tab bar has to know whether this
  // song has lyrics BEFORE the tab is pressed. Only while the sheet is open,
  // so a background session never spends requests on lyrics nobody asked for.
  const lyricsState = useLyrics(
    cleanText(String(active?.title ?? '')),
    String(active?.artist ?? ''),
    duration ? duration * 1000 : undefined,
    visible,
  );

  const [pane, setPane] = useState<Pane>('song');
  const [repeat, setRepeatState] = useState<RepeatMode>(RepeatMode.Off);
  // From the player module, not local state — the playlist screen toggles the
  // same thing, and two copies of this flag is why the icon went stale.
  const shuffled = useShuffle();
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

      seekAndShow(position + side * stacked);
      // The disc holds steady while it's up; only the number changes here.
      setSeekFlash({side, secs: stacked});
      if (flashTimer.current) {
        clearTimeout(flashTimer.current);
      }
      flashTimer.current = setTimeout(() => setSeekFlash(null), 800);
    },
    [position, duration, seekAndShow],
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
    // Lower tension + higher friction than the RN default: the old spring
    // overshot and wobbled visibly on release, which read as jittery rather
    // than smooth for a sheet this size.
    Animated.spring(sheetY, {
      toValue: 0,
      useNativeDriver: true,
      tension: 60,
      friction: 11,
    }).start();
  }, [sheetY]);

  /** Slide the rest of the way out, THEN unmount — no restart, no jump. */
  const close = useCallback(
    (velocity = 0) => {
      Animated.timing(sheetY, {
        toValue: SCREEN_H,
        // A firm flick finishes quicker than a slow drag, so the sheet keeps
        // the speed the finger gave it instead of always taking the same time.
        // Slightly longer than before — the previous timing was fast enough to
        // read as a cut rather than a slide, especially on a slow drag.
        duration: velocity > 1.5 ? 190 : 280,
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
      setPreviewDir(null); // the swap below IS the commit; no preview needed after
      Animated.timing(slide, {
        toValue: dir === 'next' ? -ART_TRAVEL : ART_TRAVEL,
        duration: 160,
        useNativeDriver: true,
      }).start(() => {
        slide.setValue(dir === 'next' ? ART_TRAVEL : -ART_TRAVEL);
        Animated.timing(slide, {
          toValue: 0,
          duration: 240,
          useNativeDriver: true,
        }).start();
      });
    },
    [slide],
  );

  /**
   * Which neighbour the title/artist row is currently previewing, if any —
   * set the moment a horizontal drag begins, so the incoming song's name is
   * already on screen and moving with the artwork, not something that only
   * appears once the finger lifts. Spotify shows the destination as you drag;
   * this used to show only the CURRENT song's name until release, then jump.
   */
  const [previewDir, setPreviewDir] = useState<'next' | 'prev' | null>(null);
  const previewTrack = previewDir
    ? peekAdjacentTrack(previewDir === 'next' ? 1 : -1)
    : null;
  const previewTitle = previewTrack ? cleanText(String(previewTrack.title ?? '')) : '';
  const previewArtists = previewTrack
    ? splitArtists(String(previewTrack.artist ?? '')).join(', ')
    : '';

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
            // Which neighbour is being dragged toward. Re-evaluated every move
            // rather than locked on the first pixel, so reversing mid-drag
            // (start left, change your mind) swaps the preview back correctly.
            const dir = g.dx < 0 ? 'next' : g.dx > 0 ? 'prev' : null;
            setPreviewDir(prev => (prev === dir ? prev : dir));
          } else if (g.dy > 0) {
            sheetY.setValue(g.dy);
          }
        },
        onPanResponderRelease: (_e, g) => {
          if (artAxis.current === 'v') {
            setPreviewDir(null);
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
            setPreviewDir(null);
            Animated.spring(slide, {
              toValue: 0,
              useNativeDriver: true,
              bounciness: 6,
            }).start();
          }
        },
        onPanResponderTerminate: () => {
          setPreviewDir(null);
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
    // A real toggle: ask the engine to flip; the icon follows whatever the
    // engine actually did (a queue with nothing upcoming can't shuffle).
    const next = !isShuffled();
    setShuffle(next).catch(() => {});
    toast(next ? 'Shuffle on' : 'Shuffle off');
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

  // Skipping to a song with no lyrics while the Lyrics pane is open would
  // otherwise strand you on a dead pane behind a dead tab.
  useEffect(() => {
    if (pane === 'lyrics' && !lyricsState.available) {
      setPane('song');
    }
  }, [pane, lyricsState.available]);

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
      {/* A GestureHandlerRootView is required INSIDE the Modal.
          react-native-gesture-handler attaches to the root view of a window,
          and on Android an RN Modal is its OWN window — so handlers mounted in
          here never see a touch unless there is a root view in this window too.
          That is why the queue's drag-to-reorder did nothing: the list was
          correct, the gestures simply never reached it. */}
      <GestureHandlerRootView style={styles.ghRoot}>
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
            <LyricsPane state={lyricsState} position={position} visible={pane === 'lyrics'} />
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
          {/* Title + credits on the left, the three per-song actions right.
              The text block moves with the SAME `slide` value as the artwork
              above, so a swipe drags them as one unit instead of the title
              sitting frozen until release. */}
          <View style={styles.metaRow}>
            <View style={styles.metaCarousel}>
              <Animated.View
                style={[styles.meta, {transform: [{translateX: slide}]}]}>
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
              </Animated.View>

              {/* The incoming title, entering from the side you're dragging
                  toward — same ART_TRAVEL offset the artwork uses, so the two
                  land in sync. Rendered only mid-gesture; the real swap
                  happens in `active` once commit() fires. */}
              {!!previewTrack && (
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.meta,
                    styles.metaPreview,
                    {
                      transform: [
                        {
                          translateX: Animated.add(
                            slide,
                            previewDir === 'next' ? ART_TRAVEL : -ART_TRAVEL,
                          ),
                        },
                      ],
                    },
                  ]}>
                  <Text style={styles.title} numberOfLines={1}>
                    {previewTitle}
                  </Text>
                  <View style={styles.creditRow}>
                    <Text style={styles.artist} numberOfLines={1}>
                      {previewArtists}
                    </Text>
                  </View>
                </Animated.View>
              )}
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

          <Seekbar position={position} duration={duration} onSeek={seekAndShow} />

          {/* Pane toggles left, audio output right — above the transport so
              the play controls never shift. */}
          <View style={styles.paneRow}>
            <View style={styles.paneTabs}>
              {PANES.map(({id, label, Icon}) => {
                const on = pane === id;
                // Lyrics goes dead when this song genuinely has none — common
                // on SoundCloud/YouTube uploads. The info glyph replaces the
                // tab's own icon and explains itself on tap, rather than
                // opening a pane that only ever says "nothing here".
                const dead = id === 'lyrics' && !lyricsState.available;
                const Glyph = dead ? Info : Icon;
                return (
                  <TouchableOpacity
                    key={id}
                    onPress={() =>
                      dead
                        ? toast('No lyrics available for this song')
                        : setPane(id)
                    }
                    activeOpacity={0.8}
                    style={[
                      styles.paneTab,
                      on && !dead && styles.paneTabOn,
                      dead && styles.paneTabDead,
                    ]}>
                    <Glyph size={15} color={on && !dead ? C.text : C.faint} />
                    <Text
                      style={[
                        styles.paneLabel,
                        on && !dead && styles.paneLabelOn,
                      ]}>
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
      </GestureHandlerRootView>
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

export type LyricsState = {
  lyrics: Lyrics | null;
  busy: boolean;
  err: string;
  /** false once we KNOW there are none — what greys out the Lyrics tab. */
  available: boolean;
};

/**
 * Fetch the lyrics for a song, once.
 *
 * This lives above LyricsPane rather than inside it because the tab bar has to
 * know the answer BEFORE you press Lyrics: SoundCloud and YouTube uploads
 * frequently have none, and a tab that opens onto "No lyrics found" is worse
 * than a tab that says so up front. One owner, one request.
 */
function useLyrics(
  title: string,
  artist: string,
  durationMs: number | undefined,
  enabled: boolean,
): LyricsState {
  const cacheKey = `${title}|${artist}`.toLowerCase();
  const cached = lyricsCache.get(cacheKey);
  const [lyrics, setLyrics] = useState<Lyrics | null>(cached ?? null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!enabled || !title) {
      return;
    }
    // Cached: paints instantly — switching Song → Queue → Lyrics must not
    // re-fetch what was on screen two taps ago.
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
  }, [cacheKey, title, artist, durationMs, enabled]);

  return {
    lyrics,
    busy,
    err,
    // While it's still loading, assume yes — the tab shouldn't flicker grey on
    // every track change.
    available: busy || !!(lyrics?.synced?.length || lyrics?.plain),
  };
}

/**
 * Synced lyrics scroll themselves and can be tapped to jump; plain text is
 * shown when that's all the sources have.
 */
function LyricsPane({
  state,
  position,
  visible = true,
}: {
  state: LyricsState;
  position: number;
  /** Mounted-but-hidden panes must not scroll a view nobody can see. */
  visible?: boolean;
}) {
  const {lyrics, busy, err} = state;
  const scroller = useRef<ScrollView>(null);

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

  // New sheet, new geometry — stale measurements would centre the wrong lines.
  useEffect(() => {
    lineTops.current = [];
  }, [lyrics]);

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
  ghRoot: {flex: 1},
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
  // Less inset than before — the artwork is the thing you came here to look
  // at, and 24px of padding on both sides was taking a visible bite out of it.
  artArea: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12},
  artHolder: {width: '100%', aspectRatio: 1, maxHeight: '100%'},
  art: {width: '100%', height: '100%', borderRadius: 10, backgroundColor: C.surface},
  artFallback: {backgroundColor: C.surfaceHi},
  tapZones: {...StyleSheet.absoluteFillObject, flexDirection: 'row'},
  tapZone: {flex: 1},

  controls: {paddingHorizontal: 24, paddingTop: 12, paddingBottom: 34},
  metaRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 12},
  // Clips the outgoing/incoming title pair to the row's own footprint, so a
  // long name sliding through never spills into the action buttons beside it.
  metaCarousel: {flex: 1, minWidth: 0, overflow: 'hidden'},
  meta: {minWidth: 0},
  metaPreview: {position: 'absolute', top: 0, left: 0, right: 0},
  title: {fontSize: 23, fontWeight: '800', color: C.text, letterSpacing: -0.3},
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
  paneTabDead: {opacity: 0.45},
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
