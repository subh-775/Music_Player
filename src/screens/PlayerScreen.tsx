/**
 * Full-screen player. Only mounted when the audio engine is running.
 */
import React from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
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
import {State, seekTo, togglePlay} from '../player';

function clock(sec: number): string {
  if (!isFinite(sec) || sec < 0) {
    return '0:00';
  }
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

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
        <TouchableOpacity style={styles.chevron} onPress={onClose}>
          <Text style={styles.chevronText}>⌄</Text>
        </TouchableOpacity>

        <View style={styles.artWrap}>
          {track.artwork ? (
            <Image source={{uri: String(track.artwork)}} style={styles.art} />
          ) : (
            <View style={[styles.art, styles.artFallback]} />
          )}
        </View>

        <View style={styles.meta}>
          <Text style={styles.title} numberOfLines={2}>
            {track.title}
          </Text>
          <Text style={styles.artist} numberOfLines={1}>
            {track.artist}
          </Text>
        </View>

        {/* Tap anywhere on the bar to seek there. A draggable thumb needs the
            gesture handler native dep; this covers the real need without it. */}
        <View style={styles.seekBlock}>
          <View
            style={styles.seekHit}
            onStartShouldSetResponder={() => true}
            onResponderRelease={e => {
              const {locationX} = e.nativeEvent;
              // Measured against the styled width below (screen - 2*gutter).
              const w = e.currentTarget as unknown as {_width?: number};
              const width = w?._width ?? 0;
              if (duration > 0 && width > 0) {
                seekTo((locationX / width) * duration);
              }
            }}
            onLayout={e => {
              // Stash the measured width on the node for the responder above.
              const node = e.currentTarget as unknown as {_width?: number};
              node._width = e.nativeEvent.layout.width;
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
          <TouchableOpacity
            style={styles.playBtn}
            onPress={togglePlay}
            activeOpacity={0.85}>
            {loading ? (
              <ActivityIndicator color={C.bg} />
            ) : (
              <Text style={styles.playIcon}>{playing ? '❚❚' : '▶'}</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: C.bg,
    paddingHorizontal: S.gutter,
    paddingTop: 44,
    paddingBottom: 40,
  },
  chevron: {alignSelf: 'flex-start', padding: 8},
  chevronText: {color: C.sub, fontSize: 26, lineHeight: 26},
  artWrap: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  art: {width: '92%', aspectRatio: 1, borderRadius: 14},
  artFallback: {backgroundColor: C.surface},
  meta: {marginTop: 8, gap: 6},
  title: {color: C.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.4},
  artist: {color: C.sub, fontSize: 14.5, fontWeight: '500'},
  seekBlock: {marginTop: 22},
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
  controls: {alignItems: 'center', marginTop: 18},
  playBtn: {
    width: 66,
    height: 66,
    borderRadius: 33,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: {color: C.bg, fontSize: 24, fontWeight: '900'},
});
