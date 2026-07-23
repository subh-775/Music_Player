/**
 * Full-screen player. Only mounted when the audio engine is running.
 *
 * The artwork is swipeable: left for next, right for previous. It uses the core
 * PanResponder rather than a gesture library, so it costs no native dependency.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
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
  useActiveTrack,
  usePlaybackState,
  useProgress,
} from 'react-native-track-player';
import {C, S} from '../theme';
import {
  RepeatMode,
  State,
  seekTo,
  setRepeat,
  shuffleQueue,
  skipNext,
  skipPrevious,
  togglePlay,
} from '../player';
import {
  ChevronDown,
  Heart,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
} from 'lucide-react-native';
import {getLyrics, type Lyrics} from '../backend';
import {useLike} from '../store';
import {QueueScreen} from './QueueScreen';

function clock(sec: number): string {
  if (!isFinite(sec) || sec < 0) {
    return '0:00';
  }
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

const SWIPE_COMMIT = 64; // px before a swipe actually changes track

export function PlayerScreen({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const track = useActiveTrack();
  const {state} = usePlaybackState() as {state?: State};
  const {position, duration} = useProgress(500);

  const likeTarget = useMemo(
    () =>
      track
        ? {title: String(track.title ?? ''), artist: String(track.artist ?? '')}
        : null,
    [track],
  );
  const {liked, toggle: toggleLike} = useLike(likeTarget as never);

  const [pane, setPane] = useState<'song' | 'lyrics' | 'queue'>('song');
  const [repeat, setRepeatState] = useState<RepeatMode>(RepeatMode.Off);
  const [seekWidth, setSeekWidth] = useState(0);
  // Double-tap seek: consecutive taps on the same side stack (10s, 20s, 30s…),
  // the way YouTube does, so a quick triple-tap jumps further.
  const [seekFlash, setSeekFlash] = useState<{side: 1 | -1; secs: number} | null>(
    null,
  );
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
      setSeekFlash({side, secs: stacked});
      if (flashTimer.current) {
        clearTimeout(flashTimer.current);
      }
      flashTimer.current = setTimeout(() => setSeekFlash(null), 650);
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

  if (!track) {
    return null;
  }

  const playing = state === State.Playing;
  const loading = state === State.Buffering || state === State.Loading;
  const pct = duration > 0 ? Math.min(1, position / duration) : 0;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent>
      <View style={styles.wrap}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={onClose} hitSlop={14} style={styles.iconBtn}>
            <ChevronDown size={26} color={C.sub} />
          </TouchableOpacity>
          <View style={styles.panes}>
            {(['song', 'lyrics', 'queue'] as const).map(p => (
              <TouchableOpacity key={p} onPress={() => setPane(p)} hitSlop={8}>
                <Text
                  style={[styles.paneTab, pane === p && styles.paneTabOn]}>
                  {p === 'song' ? 'Song' : p === 'lyrics' ? 'Lyrics' : 'Queue'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.iconBtn} />
        </View>

        {pane === 'lyrics' && <LyricsPane track={track} position={position} />}
        {pane === 'queue' && <QueueScreen />}
        {pane === 'song' && (
          <View style={styles.artArea} {...pan.panHandlers}>
            <Animated.View style={{transform: [{translateX: slide}]}}>
              {track.artwork ? (
                <Image
                  source={{uri: String(track.artwork)}}
                  style={styles.art}
                />
              ) : (
                <View style={[styles.art, styles.artFallback]} />
              )}
            </Animated.View>

            {/* Double-tap zones sit over the artwork edges. They only claim a
                TAP — the swipe PanResponder above still owns any drag. */}
            <View style={styles.tapZones} pointerEvents="box-none">
              <TapZone onDoubleTap={() => doubleTapSeek(-1)} />
              <TapZone onDoubleTap={() => doubleTapSeek(1)} />
            </View>

            {!!seekFlash && (
              <View
                style={[
                  styles.flash,
                  seekFlash.side === 1 ? styles.flashRight : styles.flashLeft,
                ]}
                pointerEvents="none">
                <Text style={styles.flashText}>
                  {seekFlash.side === 1 ? '»' : '«'} {seekFlash.secs}s
                </Text>
              </View>
            )}
          </View>
        )}

        <View style={styles.metaRow}>
          <View style={styles.meta}>
            <Text style={styles.title} numberOfLines={2}>
              {track.title}
            </Text>
            <Text style={styles.artist} numberOfLines={1}>
              {track.artist}
            </Text>
          </View>
          <TouchableOpacity onPress={toggleLike} hitSlop={12}>
            <Heart
              size={23}
              color={liked ? C.accent : C.faint}
              fill={liked ? C.accent : 'transparent'}
              strokeWidth={2}
            />
          </TouchableOpacity>
        </View>

        <View style={styles.seekBlock}>
          <View
            style={styles.seekHit}
            onLayout={e => setSeekWidth(e.nativeEvent.layout.width)}
            onStartShouldSetResponder={() => true}
            onResponderRelease={e => {
              if (duration > 0 && seekWidth > 0) {
                const ratio = Math.max(
                  0,
                  Math.min(1, e.nativeEvent.locationX / seekWidth),
                );
                seekTo(ratio * duration);
              }
            }}>
            <View style={styles.seekTrack}>
              <View style={[styles.seekFill, {flex: pct}]} />
              <View style={{flex: 1 - pct}} />
            </View>
          </View>
          <View style={styles.times}>
            <Text style={styles.time}>{clock(position)}</Text>
            <Text style={styles.time}>{clock(duration)}</Text>
          </View>
        </View>

        <View style={styles.controls}>
          <TouchableOpacity onPress={() => shuffleQueue()} hitSlop={12}>
            <Shuffle size={20} color={C.faint} strokeWidth={2.2} />
          </TouchableOpacity>

          <TouchableOpacity onPress={skipPrevious} hitSlop={12}>
            <SkipBack size={30} color={C.text} fill={C.text} strokeWidth={1} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.playBtn}
            onPress={togglePlay}
            activeOpacity={0.85}>
            {loading ? (
              <ActivityIndicator color={C.bg} />
            ) : playing ? (
              <Pause size={26} color={C.bg} fill={C.bg} strokeWidth={1} />
            ) : (
              <Play size={26} color={C.bg} fill={C.bg} strokeWidth={1} />
            )}
          </TouchableOpacity>

          <TouchableOpacity onPress={skipNext} hitSlop={12}>
            <SkipForward size={30} color={C.text} fill={C.text} strokeWidth={1} />
          </TouchableOpacity>

          <TouchableOpacity onPress={cycleRepeat} hitSlop={12}>
            {repeat === RepeatMode.Track ? (
              <Repeat1 size={20} color={C.accent} strokeWidth={2.2} />
            ) : (
              <Repeat
                size={20}
                color={repeat === RepeatMode.Queue ? C.accent : C.faint}
                strokeWidth={2.2}
              />
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

/** Half of the artwork, listening for a double tap only. A single tap is left
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

/** Synced lyrics scroll with the music; plain text is shown when that's all
 *  the sources have. */
function LyricsPane({
  track,
  position,
}: {
  track: {title?: string; artist?: string; duration?: number};
  position: number;
}) {
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setErr('');
    setLyrics(null);
    getLyrics(
      track.title || '',
      track.artist || '',
      track.duration ? track.duration * 1000 : undefined,
    )
      .then(l => alive && setLyrics(l))
      .catch(e => alive && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [track.title, track.artist, track.duration]);

  const synced = lyrics?.synced ?? [];
  const activeLine = useMemo(() => {
    if (!synced.length) {
      return -1;
    }
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
      style={styles.lyricScroll}
      contentContainerStyle={styles.lyricBody}
      showsVerticalScrollIndicator={false}>
      {synced.length > 0
        ? synced.map((line, i) => (
            <Text
              key={i}
              style={[
                styles.lyricLine,
                i === activeLine && styles.lyricLineOn,
              ]}>
              {line.text || '♪'}
            </Text>
          ))
        : (lyrics?.plain || '').split('\n').map((line, i) => (
            <Text key={i} style={styles.lyricLine}>
              {line || ' '}
            </Text>
          ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: C.bg,
    paddingHorizontal: S.gutter,
    paddingTop: 40,
    paddingBottom: 34,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  iconBtn: {padding: 8},
  chevron: {color: C.sub, fontSize: 26, lineHeight: 26},
  panes: {flexDirection: 'row', gap: 18},
  paneTab: {color: C.faint, fontSize: 13.5, fontWeight: '700'},
  paneTabOn: {color: C.accent},
  tapZones: {...StyleSheet.absoluteFillObject, flexDirection: 'row'},
  tapZone: {flex: 1},
  flash: {
    position: 'absolute',
    top: '45%',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 999,
  },
  flashLeft: {left: 18},
  flashRight: {right: 18},
  flashText: {color: C.text, fontSize: 14, fontWeight: '800'},
  artArea: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  art: {width: 300, maxWidth: '100%', aspectRatio: 1, borderRadius: 14},
  artFallback: {backgroundColor: C.surface},
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginTop: 10,
  },
  meta: {flex: 1, minWidth: 0, gap: 5},
  title: {color: C.text, fontSize: 21, fontWeight: '800', letterSpacing: -0.4},
  artist: {color: C.sub, fontSize: 14, fontWeight: '500'},
  seekBlock: {marginTop: 18},
  seekHit: {paddingVertical: 10},
  seekTrack: {
    flexDirection: 'row',
    height: 3,
    borderRadius: 2,
    backgroundColor: C.border,
    overflow: 'hidden',
  },
  seekFill: {backgroundColor: C.accent},
  times: {flexDirection: 'row', justifyContent: 'space-between'},
  time: {color: C.faint, fontSize: 11.5, fontVariant: ['tabular-nums']},
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
    paddingHorizontal: 4,
  },
  sideBtn: {color: C.faint, fontSize: 19},
  sideBtnOn: {color: C.accent},
  skip: {color: C.text, fontSize: 26},
  playBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: {color: C.bg, fontSize: 23, fontWeight: '900'},
  lyricScroll: {flex: 1, marginTop: 6},
  lyricBody: {paddingVertical: 20, gap: 12},
  lyricLine: {color: C.faint, fontSize: 16, lineHeight: 23, fontWeight: '600'},
  lyricLineOn: {color: C.text, fontSize: 18},
  lyricCenter: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  lyricEmpty: {color: C.sub, fontSize: 13.5},
});
