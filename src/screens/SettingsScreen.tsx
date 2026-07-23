import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import {C, S, T} from '../theme';
import {
  backendPort,
  getDownloadsInfo,
  getSourcesStatus,
  getYouTubeExperimental,
  setYouTubeExperimental,
  type DownloadsInfo,
  type SourceStatus,
} from '../backend';

const DOCS_URL = 'https://github.com/subh-775/Music_Player';

/** Flat grouped list — a small label over plain rows, no card fills or
 *  gradients, so the screen reads as calm and formal rather than decorated. */
function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function Row({
  label,
  value,
  hint,
}: {
  label: string;
  value?: string;
  hint?: string;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        {!!hint && <Text style={styles.rowHint}>{hint}</Text>}
      </View>
      {!!value && (
        <Text style={styles.rowValue} numberOfLines={1}>
          {value}
        </Text>
      )}
    </View>
  );
}

export function SettingsScreen() {
  const [sources, setSources] = useState<Record<string, SourceStatus>>({});
  const [downloads, setDownloads] = useState<DownloadsInfo | null>(null);
  const [yt, setYt] = useState<{supported: boolean; enabled: boolean} | null>(
    null,
  );
  const [ytBusy, setYtBusy] = useState(false);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    (async () => {
      // Each is independent — one failing shouldn't blank the whole screen.
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
      if (!yt) {
        return;
      }
      setYtBusy(true);
      try {
        const res = await setYouTubeExperimental(next);
        setYt(v => (v ? {...v, enabled: !!res.enabled} : v));
      } finally {
        setYtBusy(false);
      }
    },
    [yt],
  );

  if (busy) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={C.accent} />
      </View>
    );
  }

  const audioSources = Object.entries(sources).filter(
    ([, v]) => v.type === 'audio',
  );
  const folder = downloads?.path || downloads?.download_dir || '';

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      showsVerticalScrollIndicator={false}>
      <Text style={styles.title}>Settings</Text>

      <Section title="Sources">
        {audioSources.map(([name, s]) =>
          name === 'youtube' && yt ? (
            <View style={styles.row} key={name}>
              <View style={styles.rowText}>
                <Text style={styles.rowLabel}>YouTube</Text>
                <Text style={styles.rowHint}>
                  {ytBusy
                    ? 'Checking this device…'
                    : yt.supported
                    ? 'Adds YouTube as a search source. No sign-in needed.'
                    : 'Not available on this device.'}
                </Text>
              </View>
              <Switch
                value={yt.enabled}
                onValueChange={toggleYt}
                disabled={ytBusy || !yt.supported}
                trackColor={{false: C.border, true: C.accent}}
                thumbColor={C.text}
              />
            </View>
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

      <Section title="Engine">
        <Row label="Backend" value={`127.0.0.1:${backendPort}`} />
        <Row
          label="Playback"
          value="ExoPlayer"
          hint="Native audio — keeps playing in the background, with lock-screen and Bluetooth controls."
        />
      </Section>

      <Section title="About">
        <Row label="App" value="Music Player" />
        <Text
          style={styles.link}
          onPress={() => Linking.openURL(DOCS_URL).catch(() => {})}>
          Project on GitHub
        </Text>
      </Section>

      <View style={styles.tail} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {paddingBottom: 28},
  title: {
    ...T.screenTitle,
    color: C.text,
    paddingHorizontal: S.gutter,
    paddingTop: 8,
  },
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  section: {paddingTop: 22},
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: C.faint,
    paddingHorizontal: S.gutter,
    marginBottom: 6,
  },
  sectionBody: {},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: S.gutter,
    paddingVertical: 12,
    gap: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
  },
  rowText: {flex: 1, minWidth: 0},
  rowLabel: {...T.body, color: C.text},
  rowHint: {...T.sub, color: C.sub, marginTop: 3, lineHeight: 17},
  rowValue: {...T.sub, color: C.sub, maxWidth: 130, textAlign: 'right'},
  link: {
    color: C.accent,
    fontSize: 14,
    fontWeight: '600',
    paddingHorizontal: S.gutter,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
  },
  tail: {height: 10},
});
