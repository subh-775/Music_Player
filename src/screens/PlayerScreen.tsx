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
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Dimensions,
  Image,
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
import {Gesture, GestureDetector} from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import {C, T} from '../theme';
import {getLyrics, type Lyrics, type Track} from '../backend';
import {enqueueDownload, useIsDownloaded} from '../downloads';
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

/**
 * Full sheet travel for the open/close slide — the LONGEST edge, not the height.
 *
 * max(w, h) is the same number in both orientations; a plain `height` read is
 * not, and this activity handles rotation itself rather than being recreated.
 * A portrait height captured in landscape left "closed" only halfway down a
 * portrait screen, with the player still visible.
 */
const HIDE_Y = (({width, height}) => Math.max(width, height))(
  Dimensions.get('window'),
);

/**
 * How often the parked (closed) player polls progress.
 *
 * The player is no longer torn down when it closes — it is a view now, parked
 * off-screen — so its two progress subscriptions would otherwise poll the
 * engine forever, on every screen, for a sheet nobody can see. RNTP's
 * useProgress is a recursive setTimeout keyed on its interval, so handing it an
 * hour is how you stop it without unmounting it.
 */
const PARKED_POLL = 3600000;

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
  focusPane,
  onClose,
  onAddToPlaylist,
  onOpenArtist,
}: {
  visible: boolean;
  /**
   * Land on a particular pane — set when the drawer's Queue entry is what
   * opened the player, so you arrive at the queue rather than at the artwork.
   *
   * Carries a nonce because the request is an EVENT, not a state: asking for
   * the queue twice in a row is two requests, and a bare string would only
   * ever fire the first.
   */
  focusPane?: {pane: Pane; nonce: number} | null;
  onClose: () => void;
  onAddToPlaylist: (track: Track) => void;
  onOpenArtist: (credit: string) => void;
}) {
  const active = useActiveTrack();
  const playing = useIsPlaying();
  const output = useAudioOutput();

  /**
   * Progress is NOT subscribed to here any more.
   *
   * `useProgress(250)` at the top of this component made `position` state on a
   * 1,100-line tree, so the ENTIRE player re-rendered four times a second — the
   * artwork, the controls, the pane tabs, the lyrics scan, all of it — and it
   * did so while you were mid-drag trying to dismiss the sheet. That is most of
   * why minimising felt heavy.
   *
   * It now lives in two leaves that actually need it: <ProgressArea> (the
   * seekbar, 250ms) and <LyricsPane> (line highlighting, 500ms is plenty). Both
   * are memoised, so a progress tick re-renders a seekbar or a lyric list and
   * nothing else.
   *
   * The double-tap seek still needs to know where we are, but only at the
   * moment of a tap — never during render. ProgressArea writes each sample into
   * this ref for it.
   */
  const progressRef = useRef({position: 0, duration: 0});
  const onProgressSample = useCallback((pos: number, dur: number) => {
    progressRef.current = {position: pos, duration: dur};
  }, []);
  /** Lets the double-tap seek move the bar in the same frame it seeks, even
   *  though the bar's state now lives inside <ProgressArea>. */
  const progressApi = useRef<ProgressHandle>(null);

  // The engine's queue item is a reduced shape; the badges, download and like
  // all need the real backend Track behind it.
  const track = useMemo(() => sourceTrackFor(active), [active]);
  const {liked, toggle: toggleLike} = useLike(track);

  // The screen takes on the song's colour, darkened hard enough that every
  // label keeps contrast. Falls back to plain black when unknown.
  //
  // Only while the sheet is OPEN. The palette lookup is a full second download
  // of the cover on its own native connection — it does not share the image
  // cache the artwork itself uses — so leaving it un-gated meant every track
  // change downloaded its artwork twice, forever, for a background colour
  // behind a screen that was closed. On a weak connection that duplicate was
  // competing for bandwidth with the audio and with the cover being shown.
  // Same reasoning as the lyrics fetch just below.
  const tint = useArtworkColor(
    visible
      ? track
        ? getBestArtworkUrl(track)
        : String(active?.artwork ?? '') || undefined
      : undefined,
  );

  // Fetched here, not inside the pane: the tab bar has to know whether this
  // song has lyrics BEFORE the tab is pressed. Only while the sheet is open,
  // so a background session never spends requests on lyrics nobody asked for.
  const lyricsState = useLyrics(
    cleanText(String(active?.title ?? '')),
    String(active?.artist ?? ''),
    active?.duration ? Number(active.duration) * 1000 : undefined,
    visible,
  );

  const [pane, setPane] = useState<Pane>('song');
  const [repeat, setRepeatState] = useState<RepeatMode>(RepeatMode.Off);
  // From the player module, not local state — the playlist screen toggles the
  // same thing, and two copies of this flag is why the icon went stale.
  const shuffled = useShuffle();
  const [downloading, setDownloading] = useState(false);
  // Subscribed so the button flips to the green tick the moment the download
  // completes, and stays a tick on a song that's already on disk. A boolean
  // subscription, so an unrelated download finishing does not re-render the
  // whole player.
  const downloaded = useIsDownloaded(track);

  // Double-tap seek: consecutive taps on the same side stack (10s, 20s, 30s…),
  // the way YouTube does, so a quick triple-tap jumps further.
  const [seekFlash, setSeekFlash] = useState<{
    side: 1 | -1;
    secs: number;
  } | null>(null);
  const tapRef = useRef<{t: number; side: 1 | -1; secs: number} | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doubleTapSeek = useCallback((side: 1 | -1) => {
    const {position, duration} = progressRef.current;
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

    progressApi.current?.seek(position + side * stacked);
    // The disc holds steady while it's up; only the number changes here.
    setSeekFlash({side, secs: stacked});
    if (flashTimer.current) {
      clearTimeout(flashTimer.current);
    }
    flashTimer.current = setTimeout(() => setSeekFlash(null), 800);
  }, []);

  useEffect(
    () => () => {
      if (flashTimer.current) {
        clearTimeout(flashTimer.current);
      }
    },
    [],
  );

  /**
   * Artwork position, and the sheet's own position — both on the UI thread.
   *
   * These were Animated.Values written with setValue() from a PanResponder,
   * which meant one JS-thread write and one bridge crossing per touch event,
   * queued behind whatever React happened to be doing. Dragging the player down
   * is exactly when React is busiest, which is why minimising felt heavy while
   * the drawer — already on a shared value — did not.
   */
  const slide = useSharedValue(0);
  const sheetY = useSharedValue(HIDE_Y);
  /** Which neighbour a horizontal drag is heading toward: 1 next, -1 prev, 0
   *  none. A shared value so the incoming title can track the finger without
   *  the direction having to be React state read from a worklet. */
  const dir = useSharedValue(0);

  /**
   * Mounted from the first open, and never unmounted.
   *
   * The Modal this replaces rendered nothing at all while closed, so every open
   * paid to build a 1,100-line tree in the same frame the slide started. Parked
   * off-screen it costs one view, and both progress subscriptions inside it are
   * throttled to PARKED_POLL while `visible` is false, so an idle player is not
   * on any clock.
   */
  const [everOpened, setEverOpened] = useState(visible);
  useEffect(() => {
    if (visible) {
      setEverOpened(true);
    }
  }, [visible]);

  // onClose is an inline arrow from the app, so it changes identity on every
  // app render. Held in a ref, the settle animation's completion callback does
  // not have to be rebuilt (and re-armed) each time.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const finishClose = useCallback(() => closeRef.current(), []);

  useEffect(() => {
    if (!everOpened) {
      return;
    }
    if (visible) {
      sheetY.value = withTiming(0, {
        duration: 260,
        easing: Easing.out(Easing.cubic),
      });
    } else {
      // Already parked by whatever ran the dismissal; this only catches a close
      // that came from somewhere other than close() (navigating away, say).
      sheetY.value = HIDE_Y;
    }
  }, [visible, everOpened, sheetY]);

  /**
   * Slide the rest of the way out, THEN tell the app — no restart, no jump.
   *
   * `velocity` is px/s, straight from the gesture. A firm flick finishes quicker
   * than a slow drag, so the sheet keeps the speed the finger gave it.
   */
  const close = useCallback(
    (velocity = 0) => {
      sheetY.value = withTiming(
        HIDE_Y,
        {
          duration: velocity > 1500 ? 190 : 280,
          easing: Easing.out(Easing.cubic),
        },
        finished => {
          if (finished) {
            runOnJS(finishClose)();
          }
        },
      );
    },
    [sheetY, finishClose],
  );

  // Hardware back closes the player. The Modal used to do this via
  // onRequestClose; a view has to ask for it. Registered only while open, so a
  // parked player never intercepts a press meant for the screen behind it.
  useEffect(() => {
    if (!visible) {
      return;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [visible, close]);

  /**
   * Drag DOWN to dismiss.
   *
   * Built twice — once for the header, once as half of the artwork's race —
   * because one Gesture object drives one handler. The travel and the settle are
   * identical, so the shape lives here rather than being written out twice.
   *
   * activeOffsetY/failOffsetX are evaluated natively on the raw touch stream,
   * which is what makes a fast flick work as reliably as a slow drag: the old
   * `dy > |dx| * 1.5` predicate ran in JS after the fact, and a fast flick's
   * large first delta could fail it outright.
   */
  const makeDismiss = useCallback(
    () =>
      Gesture.Pan()
        .activeOffsetY([-1000, 10])
        .failOffsetX([-18, 18])
        .onUpdate(e => {
          sheetY.value = Math.max(0, e.translationY);
        })
        .onEnd((e, success) => {
          if (success && (e.translationY > 120 || e.velocityY > 800)) {
            // Travel the FULL remaining distance. Releasing at 35% used to call
            // onClose() outright from the artwork path, which unmounted the
            // sheet where it stood — it never covered the other 65%, which is
            // the "it doesn't completely minimize" report.
            sheetY.value = withTiming(
              HIDE_Y,
              {
                duration: e.velocityY > 1500 ? 170 : 240,
                easing: Easing.out(Easing.cubic),
              },
              finished => {
                if (finished) {
                  runOnJS(finishClose)();
                }
              },
            );
          } else {
            // Firm, and clamped: the old RN spring overshot and wobbled visibly
            // on release, which read as jittery for a sheet this size.
            sheetY.value = withSpring(0, {
              damping: 22,
              stiffness: 190,
              overshootClamping: true,
            });
          }
        }),
    [sheetY, finishClose],
  );

  const headerDismiss = useMemo(() => makeDismiss(), [makeDismiss]);

  const commit = useCallback(
    (to: 'next' | 'prev') => {
      // Fire the skip IMMEDIATELY so the engine advances during the animation,
      // not after it — that lag was the "old song lingers, then flips" bug.
      (to === 'next' ? skipNext() : skipPrevious()).catch(() => {});
      setPreviewDir(null); // the swap below IS the commit; no preview needed after
      dir.value = 0;
      const out = to === 'next' ? -ART_TRAVEL : ART_TRAVEL;
      slide.value = withTiming(out, {duration: 160}, finished => {
        if (!finished) {
          return;
        }
        // Jump to the far side with no animation, then travel back in. The
        // assignment lands before the animation initialises, so the return
        // starts from the far edge rather than from where the exit ended.
        slide.value = -out;
        slide.value = withTiming(0, {
          duration: 240,
          easing: Easing.out(Easing.cubic),
        });
      });
    },
    [slide, dir],
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
  const previewTitle = previewTrack
    ? cleanText(String(previewTrack.title ?? ''))
    : '';
  const previewArtists = previewTrack
    ? splitArtists(String(previewTrack.artist ?? '')).join(', ')
    : '';

  /**
   * Swipe LEFT/RIGHT on the artwork to change song.
   *
   * The manual axis lock this replaces (`artAxis`, set on the first move and
   * then obeyed for the rest of the drag) is gone entirely: activeOffsetX +
   * failOffsetY decide the axis natively, before either gesture has taken a
   * frame, and Gesture.Race guarantees only one of the two can ever claim the
   * touch. A mode flag inside one handler was doing that job by hand, and doing
   * it a frame late.
   */
  const skip = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-14, 14])
        .failOffsetY([-20, 20])
        .onUpdate(e => {
          slide.value = e.translationX * 0.55;
          // Which neighbour is being dragged toward. Re-evaluated every move,
          // so reversing mid-drag (start left, change your mind) swaps the
          // preview back — but JS only hears about it when the SIGN FLIPS, not
          // on every frame. That is ~2 crossings per drag instead of ~60.
          const d = e.translationX < 0 ? 1 : e.translationX > 0 ? -1 : 0;
          if (d !== dir.value) {
            dir.value = d;
            runOnJS(setPreviewDir)(d === 1 ? 'next' : d === -1 ? 'prev' : null);
          }
        })
        .onEnd((e, success) => {
          if (success && e.translationX <= -SWIPE_COMMIT) {
            runOnJS(commit)('next');
            return;
          }
          if (success && e.translationX >= SWIPE_COMMIT) {
            runOnJS(commit)('prev');
            return;
          }
          dir.value = 0;
          runOnJS(setPreviewDir)(null);
          slide.value = withSpring(0, {damping: 18, stiffness: 220});
        }),
    [slide, dir, commit],
  );

  // Whichever recognises first wins outright; they can never both claim, and
  // neither can hand over halfway through.
  const artGesture = useMemo(
    () => Gesture.Race(makeDismiss(), skip),
    [makeDismiss, skip],
  );

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{translateY: sheetY.value}],
  }));
  const artStyle = useAnimatedStyle(() => ({
    transform: [{translateX: slide.value}],
  }));
  // Same value as the artwork, deliberately: the title and credits travel as
  // one unit with the cover rather than sitting frozen until release. Its own
  // hook because Reanimated does not want one animated style on two views.
  const metaStyle = useAnimatedStyle(() => ({
    transform: [{translateX: slide.value}],
  }));
  // The INCOMING title, offset a full travel to the side you're dragging
  // toward, so it enters exactly as the outgoing one leaves.
  const metaPreviewStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: slide.value + (dir.value === 1 ? ART_TRAVEL : -ART_TRAVEL),
      },
    ],
  }));

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

  useEffect(() => {
    if (focusPane) {
      setPane(focusPane.pane);
    }
  }, [focusPane]);

  // Skipping to a song with no lyrics while the Lyrics pane is open would
  // otherwise strand you on a dead pane behind a dead tab.
  useEffect(() => {
    if (pane === 'lyrics' && !lyricsState.available) {
      setPane('song');
    }
  }, [pane, lyricsState.available]);

  if (!active || !everOpened) {
    return null;
  }

  const artwork = track
    ? getBestArtworkUrl(track)
    : String(active.artwork ?? '');
  const title = cleanText(String(active.title ?? ''));
  const artists = splitArtists(String(active.artist ?? '')).join(', ');
  const album = track?.album ? cleanText(track.album) : '';

  return (
    /**
     * A VIEW, not a Modal.
     *
     * On Android a Modal is a separate Dialog window, and windows stack by
     * window type and creation order — so a zIndex set in the main window can
     * never put anything above one. That is exactly why "Add to playlist",
     * raised from the ⊕ inside here, mounted and animated perfectly and was
     * completely invisible until the player was minimised: the sheet was in the
     * main window, the player was in a Dialog on top of it. One hierarchy fixes
     * it by construction, and the app's own GestureHandlerRootView now covers
     * these gestures, so the second root view this used to need is gone too.
     */
    <View
      style={styles.host}
      // A parked player is still in the tree; it must not eat touches meant for
      // the app behind it.
      pointerEvents={visible ? 'auto' : 'none'}>
      <Animated.View
        style={[
          styles.wrap,
          !!tint && {backgroundColor: toward(tint, 0.72)},
          sheetStyle,
        ]}>
        {/* Header — close on the left, what you're inside of in the middle.
            Drag it (or the area around it) DOWN to dismiss, like Spotify. */}
        <GestureDetector gesture={headerDismiss}>
          <View style={styles.topBar}>
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
        </GestureDetector>

        {/* The only flexible row: it shrinks and scrolls rather than pushing
            the controls below the fold. */}
        <View style={styles.pane}>
          {/* Lyrics and queue stay MOUNTED and are shown/hidden — remounting
              re-ran their whole load every pane switch, which is the 1-2s
              "loading again" the pane tabs kept showing. */}
          <View style={pane === 'lyrics' ? styles.paneFill : styles.paneOff}>
            <LyricsPane
              state={lyricsState}
              visible={visible && pane === 'lyrics'}
            />
          </View>
          <View style={pane === 'queue' ? styles.paneFill : styles.paneOff}>
            <QueuePane />
          </View>
          {pane === 'song' && (
            <GestureDetector gesture={artGesture}>
              <View style={styles.artArea}>
                <Animated.View
                  style={[styles.artHolder, artStyle]}
                  pointerEvents="none">
                  {artwork ? (
                    // Keyed by the URL: when the song changes, React swaps in
                    // a FRESH Image rather than reusing the old element (which
                    // held the previous cover visible until the new one
                    // decoded — the "previous artwork for a few ms" flash).
                    //
                    // fadeDuration=0 because the cover is prefetched (see
                    // warmArtwork in player.ts) — Android's default 300ms
                    // cross-fade was spending a third of a second dissolving
                    // in an image that was already decoded and ready to paint.
                    <Image
                      key={artwork}
                      source={{uri: artwork}}
                      style={styles.art}
                      fadeDuration={0}
                    />
                  ) : (
                    <View style={[styles.art, styles.artFallback]} />
                  )}
                </Animated.View>

                {/* Double-tap zones over the artwork edges. They claim a TAP
                      only — the pan above needs movement to activate, so a
                      stationary touch falls straight through to these. */}
                <View style={styles.tapZones} pointerEvents="box-none">
                  <TapZone onDoubleTap={() => doubleTapSeek(-1)} />
                  <TapZone onDoubleTap={() => doubleTapSeek(1)} />
                </View>

                {!!seekFlash && (
                  <SeekPeek side={seekFlash.side} seconds={seekFlash.secs} />
                )}
              </View>
            </GestureDetector>
          )}
        </View>

        <View style={styles.controls}>
          {/* Title + credits on the left, the three per-song actions right.
              The text block moves with the SAME `slide` value as the artwork
              above, so a swipe drags them as one unit instead of the title
              sitting frozen until release. */}
          <View style={styles.metaRow}>
            <View style={styles.metaCarousel}>
              <Animated.View style={[styles.meta, metaStyle]}>
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
                  style={[styles.meta, styles.metaPreview, metaPreviewStyle]}>
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

          <ProgressArea
            ref={progressApi}
            live={visible}
            onSample={onProgressSample}
          />

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
            <TouchableOpacity
              onPress={onShuffle}
              hitSlop={10}
              style={styles.tBtn}>
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
                <Play
                  size={30}
                  color={C.bg}
                  fill={C.bg}
                  style={styles.playNudge}
                />
              )}
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => skipNext()}
              hitSlop={10}
              style={styles.tBtn}>
              <SkipForward size={34} color={C.text} fill={C.text} />
            </TouchableOpacity>

            <TouchableOpacity
              onPress={toggleRepeat}
              hitSlop={10}
              style={styles.tBtn}>
              <Repeat2
                size={26}
                color={repeat === RepeatMode.Off ? C.sub : C.accent}
                strokeWidth={repeat === RepeatMode.Off ? 2 : 2.4}
              />
            </TouchableOpacity>
          </View>
        </View>

        {/* Toasts must be visible INSIDE the player — the app-root toaster
            sits underneath it, so "Downloading…" was invisible until the
            player was closed. Same queue, second outlet. */}
        <Toaster bottom={40} />
      </Animated.View>
    </View>
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

type ProgressHandle = {seek: (to: number) => void};

/**
 * The seekbar, and the ONLY thing in the player that re-renders on the clock.
 *
 * This subscription used to sit at the top of PlayerScreen, which made a
 * 1,100-line tree re-render four times a second — including while you were
 * dragging the sheet down. Here it re-renders a seekbar and nothing else.
 *
 * `onSample` mirrors each reading into the parent's ref so the double-tap seek
 * can read the position on a tap without the parent subscribing to it, and the
 * imperative `seek` lets that tap move the bar instantly rather than waiting up
 * to 250ms for the next sample.
 */
const ProgressArea = React.memo(
  React.forwardRef<
    ProgressHandle,
    {
      /** False when the player is parked off-screen — see PARKED_POLL. */
      live: boolean;
      onSample: (p: number, d: number) => void;
    }
  >(function ProgressArea({live, onSample}, ref) {
    const {position: enginePosition, duration} = useProgress(
      live ? 250 : PARKED_POLL,
    );

    /**
     * Where the bar should SAY we are.
     *
     * useProgress only samples periodically, so after a double-tap seek the bar
     * sat at the old spot until the next sample landed and the seek felt like it
     * lagged the tap. A seek publishes its target immediately and that value
     * wins until the engine's own reading catches up to it, at which point the
     * engine is authoritative again.
     */
    const [seekEcho, setSeekEcho] = useState<{at: number; to: number} | null>(
      null,
    );
    const position =
      seekEcho &&
      Math.abs(enginePosition - seekEcho.to) > 1.2 &&
      Date.now() - seekEcho.at < 1500
        ? seekEcho.to
        : enginePosition;

    useEffect(() => {
      onSample(enginePosition, duration);
    }, [enginePosition, duration, onSample]);

    /** Seek AND move the bar in the same frame. */
    const seekAndShow = useCallback((to: number) => {
      const target = Math.max(0, to);
      setSeekEcho({at: Date.now(), to: target});
      seekTo(target);
    }, []);

    useImperativeHandle(ref, () => ({seek: seekAndShow}), [seekAndShow]);

    return (
      <Seekbar position={position} duration={duration} onSeek={seekAndShow} />
    );
  }),
);

/**
 * Synced lyrics scroll themselves and can be tapped to jump; plain text is
 * shown when that's all the sources have.
 */
const LyricsPane = React.memo(function LyricsPane({
  state,
  visible = true,
}: {
  state: LyricsState;
  /** Mounted-but-hidden panes must not scroll a view nobody can see. */
  visible?: boolean;
}) {
  // Its own subscription, at half the seekbar's rate — highlighting a line does
  // not need 4Hz, and this way a lyric tick re-renders only the lyric list.
  // Parked when the pane isn't on screen, since the player no longer unmounts.
  const {position} = useProgress(visible ? 500 : PARKED_POLL);
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
              style={[
                styles.lyricLine,
                i === activeLine && styles.lyricLineOn,
              ]}>
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
});

const styles = StyleSheet.create({
  // Below the bottom sheets (40) so a sheet raised from the ⊕ in here sits on
  // top of the player, and below the drawer (45). See the note on the render.
  host: {...StyleSheet.absoluteFillObject, zIndex: 30},
  // Absolutely filling the host rather than flex:1 — the host is the thing
  // being positioned now, and `wrap` is what actually slides inside it.
  wrap: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: C.bg,
    paddingTop: 8,
  },
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
  artArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  artHolder: {width: '100%', aspectRatio: 1, maxHeight: '100%'},
  art: {
    width: '100%',
    height: '100%',
    borderRadius: 10,
    backgroundColor: C.surface,
  },
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
