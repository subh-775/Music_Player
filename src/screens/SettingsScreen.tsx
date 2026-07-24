import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  Alert,
  Animated,
  Linking,
  NativeModules,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {Check, ChevronLeft, ChevronRight} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {
  appVersion,
  backendPort,
  getDownloadsInfo,
  getSourcesStatus,
  getYouTubeExperimental,
  setDownloadsDir,
  setYouTubeExperimental,
  type DownloadsInfo,
  type SourceStatus,
} from '../backend';
import {resetSettings, useStore, writeSetting} from '../store';
import {Toggle} from '../components/Toggle';
import {EqualizerScreen} from './EqualizerScreen';
import {applyAudioEffects} from '../audioEffects';
import {EQ_PRESETS} from '../eq';
import {toast} from '../toast';
import {SOURCE_META} from '../components/Badges';

const DOCS_URL = 'https://github.com/subh-775/Music_Player';

const QUALITIES = [
  {value: 0, label: 'Auto', hint: 'Adjusts to the source'},
  {value: 96, label: 'Low', hint: '96 kbps — saves data'},
  {value: 128, label: 'Normal', hint: '128 kbps — balanced'},
  {value: 256, label: 'High', hint: '256 kbps'},
  {value: 320, label: 'Very High', hint: '320 kbps — best quality'},
];

/** Flat grouped rows — a small label over hairline-separated rows, no card
 *  fills or gradients, so the screen reads calm and formal. */
function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Row({
  label,
  value,
  hint,
  onPress,
}: {
  label: string;
  value?: string;
  hint?: string;
  onPress?: () => void;
}) {
  const Wrap: React.ElementType = onPress ? TouchableOpacity : View;
  return (
    <Wrap style={styles.row} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        {!!hint && <Text style={styles.rowHint}>{hint}</Text>}
      </View>
      {!!value && (
        <Text style={styles.rowValue} numberOfLines={1}>
          {value}
        </Text>
      )}
    </Wrap>
  );
}

function ToggleRow({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        {!!hint && <Text style={styles.rowHint}>{hint}</Text>}
      </View>
      <Toggle value={value} onChange={onChange} disabled={disabled} />
    </View>
  );
}

const CROSSFADE_MAX = 12;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * The crossfade control: a draggable bar from 0 to 12s, like the WebView build.
 * Snaps to whole seconds; 0 reads as Off.
 */
function CrossfadeRow({
  value,
  onChange,
}: {
  value: number;
  onChange: (secs: number) => void;
}) {
  // Animated fill/knob (transform-only) driven straight from the gesture; the
  // seconds label updates on whole-second changes; settings commit on release.
  const widthRef = useRef(1);
  const t = useRef(new Animated.Value(clamp01(value / CROSSFADE_MAX))).current;
  const [label, setLabel] = useState(value);
  const draggingRef = useRef(false);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    if (!draggingRef.current) {
      t.setValue(clamp01(value / CROSSFADE_MAX));
      setLabel(value);
    }
  }, [value, t]);

  const apply = useCallback(
    (x: number) => {
      const tt = clamp01(x / widthRef.current);
      t.setValue(tt);
      const secs = Math.round(tt * CROSSFADE_MAX);
      setLabel(prev => (prev === secs ? prev : secs));
      return secs;
    },
    [t],
  );

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: e => {
        draggingRef.current = true;
        apply(e.nativeEvent.locationX);
      },
      onPanResponderMove: e => apply(e.nativeEvent.locationX),
      onPanResponderRelease: e => {
        const secs = apply(e.nativeEvent.locationX);
        draggingRef.current = false;
        changeRef.current(secs);
      },
      onPanResponderTerminate: () => {
        draggingRef.current = false;
      },
    }),
  ).current;

  // Percentage interpolation — the track width is dynamic, so this avoids
  // measuring it. Still no React re-render per frame.
  const pct = t.interpolate({inputRange: [0, 1], outputRange: ['0%', '100%']});
  const fillStyle = {width: pct};
  const knobStyle = {left: pct};

  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>Crossfade</Text>
        <View
          style={styles.fadeTrackArea}
          onLayout={e => {
            widthRef.current = Math.max(1, e.nativeEvent.layout.width);
          }}
          {...pan.panHandlers}>
          <View style={styles.fadeTrack} />
          <Animated.View style={[styles.fadeFill, fillStyle]} />
          <Animated.View style={[styles.fadeKnob, knobStyle]} />
        </View>
      </View>
      <Text style={styles.rowValue}>{label > 0 ? `${label}s` : 'Off'}</Text>
    </View>
  );
}

function NavRow({
  label,
  value,
  onPress,
}: {
  label: string;
  value?: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
      <Text style={[styles.rowLabel, styles.rowText]}>{label}</Text>
      {!!value && <Text style={styles.rowValue}>{value}</Text>}
      <ChevronRight size={18} color={C.faint} />
    </TouchableOpacity>
  );
}

export function SettingsScreen({onClose}: {onClose: () => void}) {
  const [panel, setPanel] = useState<'equalizer' | null>(null);
  const {settings} = useStore();
  const [sources, setSources] = useState<Record<string, SourceStatus>>({});
  const [downloads, setDownloads] = useState<DownloadsInfo | null>(null);
  const [yt, setYt] = useState<{supported: boolean; enabled: boolean} | null>(
    null,
  );
  const [ytBusy, setYtBusy] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);

  useEffect(() => {
    (async () => {
      // Independent — one failing shouldn't blank the whole screen. And NOT
      // gated behind a full-screen spinner: every setting above Sources is
      // local and instant, so the screen paints immediately and the
      // backend-backed rows (sources, download folder) fill in when ready.
      // The old spinner made opening Settings feel like loading a web page.
      const [s, d, y] = await Promise.allSettled([
        getSourcesStatus(),
        getDownloadsInfo(),
        getYouTubeExperimental(),
      ]);
      if (s.status === 'fulfilled') {
        setSources(s.value);
      }
      if (d.status === 'fulfilled') {
        setDownloads(d.value);
      }
      if (y.status === 'fulfilled') {
        setYt(y.value);
      }
    })();
  }, []);

  const toggleYt = useCallback(
    async (next: boolean) => {
      setYtBusy(true);
      try {
        const res = await setYouTubeExperimental(next);
        setYt(v => (v ? {...v, enabled: !!res.enabled} : v));
      } finally {
        setYtBusy(false);
      }
    },
    [],
  );

  const qualityLabel =
    QUALITIES.find(q => q.value === settings.audioQuality)?.label ?? 'Very High';
  const folder = downloads?.path || downloads?.download_dir || '';

  /** System folder picker -> backend. The backend refuses an unwritable folder,
   *  so a bad pick fails loudly here instead of silently failing downloads. */
  const pickDownloadFolder = useCallback(async () => {
    const native = NativeModules.Backend as {pickFolder?: () => Promise<string>};
    if (typeof native.pickFolder !== 'function') {
      toast('Folder picking needs the newest APK.');
      return;
    }
    try {
      const path = await native.pickFolder();
      if (!path) {
        return; // backed out of the picker
      }
      const res = await setDownloadsDir(path);
      if (res.ok === false) {
        toast(res.error || 'Could not use that folder');
        return;
      }
      setDownloads(d => ({...(d ?? {}), ...res}));
      toast('Download folder updated');
    } catch {
      toast('Could not change the folder');
    }
  }, []);

  const confirmReset = useCallback(() => {
    Alert.alert(
      'Reset all settings?',
      "Everything goes back to defaults. Your library isn't touched.",
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Reset', style: 'destructive', onPress: resetSettings},
      ],
    );
  }, []);

  // Anything with more than a switch's worth of choice gets its OWN screen,
  // not an inline expander — the list stays scannable.
  if (panel === 'equalizer') {
    return <EqualizerScreen onClose={() => setPanel(null)} />;
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.back}>
          <ChevronLeft size={28} color={C.text} />
        </TouchableOpacity>
        <Text style={styles.barTitle}>Settings</Text>
      </View>

      <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}>
          <Section title="Media quality">
            <Row
              label="Streaming quality"
              value={qualityLabel}
              onPress={() => setQualityOpen(v => !v)}
              hint="Higher sounds better and uses more data"
            />
            {qualityOpen &&
              QUALITIES.map(q => (
                <TouchableOpacity
                  key={q.value}
                  style={styles.choice}
                  activeOpacity={0.7}
                  onPress={() => {
                    writeSetting('audioQuality', q.value);
                    setQualityOpen(false);
                  }}>
                  <View style={styles.rowText}>
                    <Text
                      style={[
                        styles.rowLabel,
                        settings.audioQuality === q.value && styles.choiceOn,
                      ]}>
                      {q.label}
                    </Text>
                    <Text style={styles.rowHint}>{q.hint}</Text>
                  </View>
                  {settings.audioQuality === q.value && (
                    <Check size={18} color={C.accent} strokeWidth={2.6} />
                  )}
                </TouchableOpacity>
              ))}
            <ToggleRow
              label="Source badge"
              hint="Show which source a track came from"
              value={settings.showSourceBadge}
              onChange={v => writeSetting('showSourceBadge', v)}
            />
            <ToggleRow
              label="Quality badge"
              hint="Show the streaming bitrate"
              value={settings.showQualityBadge}
              onChange={v => writeSetting('showQualityBadge', v)}
            />
          </Section>

          <Section title="Playback">
            <ToggleRow
              label="Autoplay"
              hint="Keep playing similar songs when the queue ends"
              value={settings.autoplay}
              onChange={v => writeSetting('autoplay', v)}
            />
          </Section>

          <Section title="Sound">
            <NavRow
              label="Equalizer"
              value={
                settings.eqEnabled
                  ? EQ_PRESETS.find(p => p.id === settings.eqPreset)?.label ||
                    'Custom'
                  : 'Off'
              }
              onPress={() => setPanel('equalizer')}
            />
            <CrossfadeRow
              value={settings.crossfadeDuration}
              onChange={secs => writeSetting('crossfadeDuration', secs)}
            />
            <ToggleRow
              label="Normalize volume"
              hint="Even out loudness between songs"
              value={settings.normalizeVolume}
              onChange={v => {
                writeSetting('normalizeVolume', v);
                applyAudioEffects();
              }}
            />
          </Section>

          <Section title="Sources">
            {Object.keys(sources).length === 0 && (
              <Text style={styles.folderPath}>Checking sources…</Text>
            )}
            {Object.entries(sources)
              .filter(([, v]) => v.type === 'audio')
              .map(([name, s]) => {
                // Same tints as the track badges, so "which source is this"
                // reads the same everywhere.
                const tint = SOURCE_META[name]?.tint;
                return name === 'youtube' ? (
                  <View key={name} style={styles.row}>
                    <View style={styles.rowText}>
                      <Text style={[styles.rowLabel, !!tint && {color: tint}]}>
                        YouTube
                      </Text>
                      <Text style={styles.rowHint}>
                        {ytBusy
                          ? 'Checking this device…'
                          : yt?.supported
                          ? 'Adds YouTube as a search source. No sign-in needed.'
                          : 'Not available on this device.'}
                      </Text>
                    </View>
                    <Toggle
                      value={!!yt?.enabled}
                      disabled={ytBusy || !yt?.supported}
                      onChange={toggleYt}
                    />
                  </View>
                ) : (
                  <View key={name} style={styles.row}>
                    <View style={styles.rowText}>
                      <Text style={[styles.rowLabel, !!tint && {color: tint}]}>
                        {SOURCE_META[name]?.label ||
                          (name === 'jiosaavn' ? 'JioSaavn' : 'SoundCloud')}
                      </Text>
                      {!!s.quality && (
                        <Text style={styles.rowHint}>{s.quality}</Text>
                      )}
                    </View>
                    <Text style={styles.rowValue}>
                      {s.status === 'ready' ? 'On' : s.status}
                    </Text>
                  </View>
                );
              })}
          </Section>

          <Section title="Storage">
            <NavRow
              label="Download folder"
              value={downloads?.using_fallback ? 'Private' : undefined}
              onPress={pickDownloadFolder}
            />
            <Text style={styles.folderPath} numberOfLines={2}>
              {folder || 'Not available yet'}
            </Text>
          </Section>

          <Section title="About">
            <Row label="Version" value={appVersion || '—'} />
            <Row label="Engine" value={`ExoPlayer · :${backendPort}`} />
            <Row
              label="Project on GitHub"
              onPress={() => Linking.openURL(DOCS_URL).catch(() => {})}
            />
          </Section>

          <TouchableOpacity
            style={styles.reset}
            activeOpacity={0.7}
            onPress={confirmReset}>
            <Text style={styles.resetText}>Reset all settings</Text>
            <Text style={styles.rowHint}>
              Puts everything back to defaults. Your library isn&apos;t touched.
            </Text>
          </TouchableOpacity>

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
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  // Enough tail room that the last row clears the mini player + bottom nav —
  // the reset button was getting clipped by a small amount.
  scroll: {paddingBottom: 90},
  section: {paddingTop: 20},
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: C.faint,
    paddingHorizontal: S.gutter,
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: S.gutter,
    paddingVertical: 12,
    gap: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: S.gutter + 10,
    paddingVertical: 10,
    gap: 14,
    backgroundColor: C.surface,
  },
  choiceOn: {color: C.accent},
  rowText: {flex: 1, minWidth: 0},
  rowLabel: {...T.body, color: C.text},
  rowHint: {...T.sub, color: C.sub, marginTop: 3, lineHeight: 17},
  rowValue: {...T.sub, color: C.sub, maxWidth: 140, textAlign: 'right'},
  reset: {
    marginTop: 26,
    paddingHorizontal: S.gutter,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
  },
  resetText: {color: C.danger, fontSize: 15, fontWeight: '700'},
  tail: {height: 10},
  folderPath: {
    ...T.sub,
    color: C.sub,
    paddingHorizontal: S.gutter,
    paddingBottom: 10,
    marginTop: -6,
  },
  fadeTrackArea: {
    // 44px touch target (Fitts'), while the bar still reads as 4px.
    height: 44,
    justifyContent: 'center',
    marginTop: 4,
    marginRight: 4,
  },
  fadeTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  fadeFill: {
    position: 'absolute',
    height: 4,
    borderRadius: 2,
    backgroundColor: C.accent,
  },
  fadeKnob: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8,
    marginLeft: -8,
    backgroundColor: C.accentBright,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 3,
    shadowOffset: {width: 0, height: 1},
    elevation: 3,
  },
});
