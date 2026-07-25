/**
 * Tips & shortcuts — every gesture the app understands, in one place.
 *
 * The app is gesture-first (it's for a phone held one-handed from the bottom),
 * so the gestures need somewhere discoverable to live. This is that page; new
 * gestures get a row here as they're added.
 */
import React from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  ChevronLeft,
  ChevronsLeftRight,
  Hand,
  ListMusic,
  MousePointerClick,
  Move,
  Pin,
  Repeat,
  Undo2,
} from 'lucide-react-native';
import {C, S, T} from '../theme';

type Tip = {Icon: typeof Hand; title: string; body: string};

const GROUPS: {title: string; tips: Tip[]}[] = [
  {
    title: 'Now playing',
    tips: [
      {
        Icon: ChevronsLeftRight,
        title: 'Double-tap the artwork',
        body: 'Left jumps back 10s, right jumps forward 10s. Keep tapping to stack — 10, 20, 30…',
      },
      {
        Icon: Move,
        title: 'Swipe the artwork',
        body: 'Left for the next song, right for the previous one.',
      },
      {
        Icon: Undo2,
        title: 'Swipe down to minimize',
        body: 'Pull the player down to tuck it back into the mini bar.',
      },
      {
        Icon: MousePointerClick,
        title: 'Tap a lyric line',
        body: 'Jumps playback straight to that moment (synced lyrics only).',
      },
    ],
  },
  {
    title: 'Mini player',
    tips: [
      {
        Icon: MousePointerClick,
        title: 'Tap to expand',
        body: 'Opens the full now-playing screen.',
      },
      {
        Icon: Move,
        title: 'Swipe left or right',
        body: 'Skips to the next or previous song without opening the player.',
      },
    ],
  },
  {
    title: 'Songs & queue',
    tips: [
      {
        Icon: ListMusic,
        title: 'Swipe a song right',
        body: 'Adds it to the queue to play after what’s lined up.',
      },
      {
        Icon: Hand,
        title: 'Hold a song',
        body: 'Opens more options — add to a playlist, go to the artist or album.',
      },
      {
        Icon: Repeat,
        title: 'Drag the grip in Queue',
        body: 'Reorders what plays next; drop it where you want it.',
      },
    ],
  },
  {
    title: 'Library',
    tips: [
      {
        Icon: Pin,
        title: 'Hold a playlist',
        body: 'Pin it to the top, rename it, or delete it.',
      },
      {
        Icon: ChevronLeft,
        title: 'Back button',
        body: 'Steps back one screen. On Home, press twice to exit — so a stray tap can’t stop the music.',
      },
    ],
  },
];

export function TipsScreen({onClose}: {onClose: () => void}) {
  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.back}>
          <ChevronLeft size={28} color={C.text} />
        </TouchableOpacity>
        <Text style={styles.barTitle}>Tips &amp; shortcuts</Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}>
        <Text style={styles.intro}>
          This app runs on gestures. Here’s everything your fingers can do.
        </Text>
        {GROUPS.map(g => (
          <View key={g.title} style={styles.group}>
            <Text style={styles.groupTitle}>{g.title}</Text>
            {g.tips.map(t => (
              <View key={t.title} style={styles.tip}>
                <View style={styles.chip}>
                  <t.Icon size={19} color={C.accent} strokeWidth={2} />
                </View>
                <View style={styles.tipText}>
                  <Text style={styles.tipTitle}>{t.title}</Text>
                  <Text style={styles.tipBody}>{t.body}</Text>
                </View>
              </View>
            ))}
          </View>
        ))}
        <View style={styles.tail} />
      </ScrollView>
    </View>
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
    paddingBottom: 4,
  },
  back: {padding: 4},
  barTitle: {...T.screenTitle, color: C.text, fontSize: 22},
  scroll: {paddingBottom: 90, paddingHorizontal: S.gutter},
  intro: {color: C.sub, fontSize: 13.5, lineHeight: 20, marginTop: 6, marginBottom: 6},
  group: {marginTop: 20},
  groupTitle: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: C.faint,
    marginBottom: 10,
  },
  tip: {flexDirection: 'row', gap: 14, marginBottom: 16, alignItems: 'flex-start'},
  chip: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: C.surfaceHi,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tipText: {flex: 1, minWidth: 0},
  tipTitle: {color: C.text, fontSize: 14.5, fontWeight: '700'},
  tipBody: {color: C.sub, fontSize: 13, lineHeight: 19, marginTop: 3},
  tail: {height: 10},
});
