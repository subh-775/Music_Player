import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {Check, ChevronLeft} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {
  appVersion,
  backendPort,
  getDownloadsInfo,
  getSourcesStatus,
  getYouTubeExperimental,
  setYouTubeExperimental,
  type DownloadsInfo,
  type SourceStatus,
} from '../backend';
import {resetSettings, useStore, writeSetting} from '../store';

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
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{false: C.border, true: C.accent}}
        thumbColor={C.text}
      />
    </View>
  );
}

export function SettingsScreen({onClose}: {onClose: () => void}) {
  const {settings} = useStore();
  const [sources, setSources] = useState<Record<string, SourceStatus>>({});
  const [downloads, setDownloads] = useState<DownloadsInfo | null>(null);
  const [yt, setYt] = useState<{supported: boolean; enabled: boolean} | null>(
    null,
  );
  const [ytBusy, setYtBusy] = useState(false);
  const [busy, setBusy] = useState(true);
  const [qualityOpen, setQualityOpen] = useState(false);

  useEffect(() => {
    (async () => {
      // Independent — one failing shouldn't blank the whole screen.
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
      setBusy(false);
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

  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.back}>
          <ChevronLeft size={28} color={C.text} />
        </TouchableOpacity>
        <Text style={styles.barTitle}>Settings</Text>
      </View>

      {busy ? (
        <View style={styles.center}>
          <ActivityIndicator color={C.accent} />
        </View>
      ) : (
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

          <Section title="Sources">
            {Object.entries(sources)
              .filter(([, v]) => v.type === 'audio')
              .map(([name, s]) =>
                name === 'youtube' ? (
                  <ToggleRow
                    key={name}
                    label="YouTube"
                    hint={
                      ytBusy
                        ? 'Checking this device…'
                        : yt?.supported
                        ? 'Adds YouTube as a search source. No sign-in needed.'
                        : 'Not available on this device.'
                    }
                    value={!!yt?.enabled}
                    disabled={ytBusy || !yt?.supported}
                    onChange={toggleYt}
                  />
                ) : (
                  <Row
                    key={name}
                    label={name === 'jiosaavn' ? 'JioSaavn' : 'SoundCloud'}
                    value={s.status === 'ready' ? 'On' : s.status}
                    hint={s.quality}
                  />
                ),
              )}
          </Section>

          <Section title="Storage">
            <Row
              label="Download folder"
              hint={folder || 'Not available yet'}
              value={downloads?.using_fallback ? 'Private' : undefined}
            />
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
            onPress={resetSettings}>
            <Text style={styles.resetText}>Reset all settings</Text>
            <Text style={styles.rowHint}>
              Puts everything back to defaults. Your library isn&apos;t touched.
            </Text>
          </TouchableOpacity>

          <View style={styles.tail} />
        </ScrollView>
      )}
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
  scroll: {paddingBottom: 30},
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
});
