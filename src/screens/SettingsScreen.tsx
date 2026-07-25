import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  BackHandler,
  Linking,
  NativeModules,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FolderOpen,
} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {
  appVersion,
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
import {TipsScreen} from './TipsScreen';
import {ConfirmModal} from '../components/ConfirmModal';
import {applyAudioEffects} from '../audioEffects';
import {EQ_PRESETS} from '../eq';
import {toast} from '../toast';
import {SOURCE_META} from '../components/Badges';
import {checkUpdate, updateSupported, useUpdate} from '../update';

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

/**
 * The crossfade control: a plain −/+ stepper (0–12s), 0 reads as Off.
 *
 * Replaced the draggable bar — precise dragging on a thin track was fiddly to
 * land on an exact second. Two big taps are exact and comfortable one-handed.
 * The number pops on each change so the press registers.
 */
function CrossfadeStepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (secs: number) => void;
}) {
  const step = (delta: number) => {
    const next = Math.max(0, Math.min(CROSSFADE_MAX, value + delta));
    if (next !== value) {
      onChange(next);
    }
  };
  const atMin = value <= 0;
  const atMax = value >= CROSSFADE_MAX;

  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>Crossfade</Text>
        <Text style={styles.rowHint}>Overlap the end of one song into the next</Text>
      </View>
      <View style={styles.stepper}>
        <TouchableOpacity
          onPress={() => step(-1)}
          disabled={atMin}
          hitSlop={8}
          activeOpacity={0.6}
          style={styles.stepBtn}>
          <ChevronsLeft size={22} color={atMin ? C.faint : C.text} />
        </TouchableOpacity>
        <Text style={styles.stepValue}>{value > 0 ? `${value}s` : 'Off'}</Text>
        <TouchableOpacity
          onPress={() => step(1)}
          disabled={atMax}
          hitSlop={8}
          activeOpacity={0.6}
          style={styles.stepBtn}>
          <ChevronsRight size={22} color={atMax ? C.faint : C.text} />
        </TouchableOpacity>
      </View>
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
  const [panel, setPanel] = useState<'equalizer' | 'tips' | 'playback' | null>(
    null,
  );
  const [resetOpen, setResetOpen] = useState(false);
  const {settings} = useStore();
  const [sources, setSources] = useState<Record<string, SourceStatus>>({});
  const [downloads, setDownloads] = useState<DownloadsInfo | null>(null);
  const [yt, setYt] = useState<{supported: boolean; enabled: boolean} | null>(
    null,
  );
  const [ytBusy, setYtBusy] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);

  // A sub-panel (Equalizer, Tips) must catch the hardware back itself and
  // return to Settings — NOT fall through to the app-level handler, which would
  // close Settings entirely and drop you on Home. Registered after the app's
  // handler, so it runs first; when no panel is open it declines and the app's
  // handler closes Settings as before.
  useEffect(() => {
    const onBack = () => {
      if (panel) {
        setPanel(null);
        return true;
      }
      return false;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [panel]);

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

  const doReset = useCallback(() => {
    resetSettings();
    setResetOpen(false);
    toast('Settings reset to defaults');
  }, []);

  // Real check: asks GitHub for the latest release. A newer one raises the
  // in-app update popup (UpdateModal); "up to date" just toasts. The manualCheck
  // ref keeps the launch-time silent check from toasting on its own.
  const update = useUpdate();
  const manualCheck = useRef(false);
  const checkUpdates = useCallback(() => {
    if (!updateSupported) {
      toast('Updating needs the newest APK.');
      return;
    }
    manualCheck.current = true;
    toast('Checking for updates…');
    checkUpdate();
  }, []);
  useEffect(() => {
    if (!manualCheck.current) {
      return;
    }
    if (update.phase === 'current') {
      manualCheck.current = false;
      toast(
        appVersion
          ? `You're on the latest version (${appVersion})`
          : "You're on the latest version",
      );
    } else if (update.phase === 'found') {
      manualCheck.current = false; // the popup takes over
    }
  }, [update.phase]);

  // Anything with more than a switch's worth of choice gets its OWN screen,
  // not an inline expander — the list stays scannable.
  if (panel === 'equalizer') {
    return <EqualizerScreen onClose={() => setPanel(null)} />;
  }
  if (panel === 'tips') {
    return <TipsScreen onClose={() => setPanel(null)} />;
  }
  if (panel === 'playback') {
    return (
      <View style={styles.wrap}>
        <View style={[styles.bar, styles.barElevated]}>
          <TouchableOpacity
            onPress={() => setPanel(null)}
            hitSlop={12}
            style={styles.back}>
            <ChevronLeft size={28} color={C.text} />
          </TouchableOpacity>
          <Text style={styles.barTitle}>Playback</Text>
        </View>
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          overScrollMode="never"
          bounces={false}>
          <Section title="Listening controls">
            <ToggleRow
              label="Autoplay"
              hint="Similar songs keep playing when your queue ends."
              value={settings.autoplay}
              onChange={v => writeSetting('autoplay', v)}
            />
            <ToggleRow
              label="Normalize volume"
              hint="Set the same loudness level for all tracks."
              value={settings.normalizeVolume}
              onChange={v => {
                writeSetting('normalizeVolume', v);
                applyAudioEffects();
              }}
            />
            <ToggleRow
              label="Reduce animations"
              hint="Turn off non-essential motion around the app."
              value={settings.reduceAnimations}
              onChange={v => writeSetting('reduceAnimations', v)}
            />
          </Section>

          <Section title="Track transitions">
            <CrossfadeStepper
              value={settings.crossfadeDuration}
              onChange={secs => writeSetting('crossfadeDuration', secs)}
            />
          </Section>
          <View style={styles.tail} />
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <View style={[styles.bar, styles.barElevated]}>
        <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.back}>
          <ChevronLeft size={28} color={C.text} />
        </TouchableOpacity>
        <Text style={styles.barTitle}>Settings</Text>
      </View>

      <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          overScrollMode="never"
          bounces={false}>
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

          <Section title="Player">
            <NavRow
              label="Playback"
              value={
                settings.crossfadeDuration > 0
                  ? `Crossfade ${settings.crossfadeDuration}s`
                  : undefined
              }
              onPress={() => setPanel('playback')}
            />
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
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.rowLabel}>Download folder</Text>
                <Text style={styles.rowHint} numberOfLines={2}>
                  {folder ||
                    (downloads?.using_fallback
                      ? 'Using private app storage'
                      : 'Not available yet')}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.setBtn}
                onPress={pickDownloadFolder}
                activeOpacity={0.85}>
                <FolderOpen size={15} color={C.text} strokeWidth={2.2} />
                <Text style={styles.setBtnText}>Set folder</Text>
              </TouchableOpacity>
            </View>
          </Section>

          <Section title="About">
            <Row label="Version" value={appVersion || '—'} />
            <NavRow label="Check for updates" onPress={checkUpdates} />
            <NavRow label="Tips & shortcuts" onPress={() => setPanel('tips')} />
            <Row
              label="Project on GitHub"
              onPress={() => Linking.openURL(DOCS_URL).catch(() => {})}
            />
          </Section>

          <TouchableOpacity
            style={styles.reset}
            activeOpacity={0.7}
            onPress={() => setResetOpen(true)}>
            <Text style={styles.resetText}>Reset all settings</Text>
            <Text style={styles.rowHint}>
              Puts everything back to defaults. Your library isn&apos;t touched.
            </Text>
          </TouchableOpacity>

          <View style={styles.tail} />
        </ScrollView>

        <ConfirmModal
          visible={resetOpen}
          title="Reset all settings?"
          message="Everything goes back to defaults. Your library isn't touched."
          confirmLabel="Reset"
          danger
          onConfirm={doReset}
          onCancel={() => setResetOpen(false)}
        />
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
  // A softly elevated header — a lift off the black body that reads like the
  // subtle grey gradient on Spotify's own sub-screen bars, without pulling in a
  // gradient dependency.
  barElevated: {
    backgroundColor: C.surface,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: {width: 0, height: 3},
    elevation: 5,
  },
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
  stepper: {flexDirection: 'row', alignItems: 'center', gap: 2},
  stepBtn: {padding: 6, borderRadius: 999},
  stepValue: {
    color: C.text,
    fontSize: 15,
    fontWeight: '700',
    minWidth: 46,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  setBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: C.surfaceHi,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
  },
  setBtnText: {color: C.text, fontWeight: '700', fontSize: 13},
});
