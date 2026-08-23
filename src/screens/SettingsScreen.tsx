import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  Animated,
  BackHandler,
  Easing,
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
  ExternalLink,
  Eye,
  Gauge,
  HardDrive,
  Info,
  Radio,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {
  appVersion,
  clearBackendCache,
  getCacheSize,
  getDownloadsInfo,
  getSourcesStatus,
  getYouTubeExperimental,
  setDownloadsDir,
  setYouTubeExperimental,
  type DownloadsInfo,
  type SourceStatus,
} from '../backend';
import {resetSettings, useStore, writeSetting} from '../store';
import {clearSearchHistory} from '../searchHistory';
import {Toggle} from '../components/Toggle';
import {EqualizerScreen} from './EqualizerScreen';
import {TipsScreen} from './TipsScreen';
import {ConfirmModal} from '../components/ConfirmModal';
import {applyAudioEffects} from '../audioEffects';
import {EQ_PRESETS} from '../eq';
import {toast} from '../toast';
import {SOURCE_META} from '../components/Badges';
import {checkUpdate, startUpdateInstall, useUpdate} from '../update';
import {
  cancelSleepTimer,
  sleepAtEndOfTrack,
  sleepLabel,
  startSleepTimer,
  useSleepTimer,
} from '../sleepTimer';

const DOCS_URL = 'https://github.com/subh-775/Music_Player';

function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  const mb = n / (1024 * 1024);
  return mb < 1 ? `${Math.round(n / 1024)} KB` : `${mb.toFixed(1)} MB`;
}

/**
 * What the last visit to this screen learned from the backend.
 *
 * Settings is an overlay that UNMOUNTS when closed, so every reopen started
 * from scratch: sources showed "Checking sources…", the YouTube switch sat
 * disabled, the download folder was blank and the cache size was missing —
 * every single time, for as long as four backend round trips took. None of it
 * changes between two opens a minute apart, so it is remembered here and used
 * as the initial state; the fetch still runs and overwrites it, but the screen
 * is already complete while that happens.
 *
 * Module scope, not a store: it is a cache of remote answers, not state anyone
 * else needs to read, and it should die with the process.
 */
const remote: {
  sources: Record<string, SourceStatus>;
  downloads: DownloadsInfo | null;
  yt: {supported: boolean; enabled: boolean} | null;
  cacheBytes: number | null;
} = {sources: {}, downloads: null, yt: null, cacheBytes: null};

const QUALITIES = [
  {value: 0, label: 'Auto', hint: 'Adjusts to the source'},
  {value: 96, label: 'Low', hint: '96 kbps — saves data'},
  {value: 128, label: 'Normal', hint: '128 kbps — balanced'},
  {value: 256, label: 'High', hint: '256 kbps'},
  {value: 320, label: 'Very High', hint: '320 kbps — best quality'},
];

/**
 * A settings group: a small icon + label, over one rounded card holding its
 * rows.
 *
 * The flat version — a label and then rows ruled edge to edge — made the whole
 * screen one continuous ribbon of hairlines, so no group had a visible start or
 * end and everything read as a single undifferentiated list. A card gives each
 * group a boundary, which is what makes it scannable.
 *
 * Separators are injected BETWEEN children rather than set as a border on each
 * row, so the first row never carries a stray line under the card's top edge.
 */
function Section({
  title,
  Icon,
  footer,
  highlight,
  children,
}: {
  title: string;
  Icon?: typeof HardDrive;
  /** One line under the card, for the explanation that would otherwise be
   *  crammed into a row's `hint`. */
  footer?: string;
  /** Briefly ring the card — used when Settings is opened straight at a
   *  specific section, so it is obvious which one you were sent to. */
  highlight?: boolean;
  children: React.ReactNode;
}) {
  const items = React.Children.toArray(children);
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        {!!Icon && <Icon size={13} color={C.faint} strokeWidth={2.6} />}
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      <View style={[styles.card, !!highlight && styles.cardHighlight]}>
        {items.map((child, i) => (
          // child.key, not the index. These children are conditional (the
          // update row's states, the sources list), and an index key makes
          // React reuse the wrong instance when one appears or disappears —
          // component state leaks across rows. React.Children.toArray already
          // assigns stable keys; use them.
          <React.Fragment key={(child as {key?: string}).key ?? i}>
            {i > 0 && <View style={styles.sep} />}
            {child}
          </React.Fragment>
        ))}
      </View>
      {!!footer && <Text style={styles.sectionFooter}>{footer}</Text>}
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
      {/* A row that DOES something has to look different from one that just
          reports a number. Without this, "Streaming quality — Very High" was
          indistinguishable from a read-only line, so nobody knew it opened. */}
      {!!onPress && <ChevronRight size={17} color={C.faint} />}
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
        <Text style={styles.rowHint}>
          Overlap the end of one song into the next
        </Text>
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

export function SettingsScreen({
  onClose,
  focus,
}: {
  onClose: () => void;
  /** Open the screen AT something. 'update' scrolls to Software update and
   *  rings it briefly — what the dot on the hamburger now points at. */
  focus?: 'update' | null;
}) {
  const [panel, setPanel] = useState<'equalizer' | 'tips' | 'playback' | null>(
    null,
  );
  const [resetOpen, setResetOpen] = useState(false);
  const [cacheOpen, setCacheOpen] = useState(false);
  const [cacheBytes, setCacheBytes] = useState<number | null>(
    remote.cacheBytes,
  );
  const [clearing, setClearing] = useState(false);
  const {settings} = useStore();
  const [sources, setSources] = useState<Record<string, SourceStatus>>(
    remote.sources,
  );
  const [downloads, setDownloads] = useState<DownloadsInfo | null>(
    remote.downloads,
  );
  const [yt, setYt] = useState<{supported: boolean; enabled: boolean} | null>(
    remote.yt,
  );
  const [ytBusy, setYtBusy] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const sleep = useSleepTimer();
  const scrollRef = useRef<ScrollView>(null);
  const updateY = useRef(0);
  const [glow, setGlow] = useState(false);

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
      const [s, d, y, c] = await Promise.allSettled([
        getSourcesStatus(),
        getDownloadsInfo(),
        getYouTubeExperimental(),
        getCacheSize(),
      ]);
      if (s.status === 'fulfilled') {
        remote.sources = s.value;
        setSources(s.value);
      }
      if (d.status === 'fulfilled') {
        remote.downloads = d.value;
        setDownloads(d.value);
      }
      if (y.status === 'fulfilled') {
        remote.yt = y.value;
        setYt(y.value);
      }
      if (c.status === 'fulfilled') {
        remote.cacheBytes = c.value.bytes;
        setCacheBytes(c.value.bytes);
      }
    })();
  }, []);

  const toggleYt = useCallback(async (next: boolean) => {
    setYtBusy(true);
    try {
      const res = await setYouTubeExperimental(next);
      setYt(v => {
        const now = v ? {...v, enabled: !!res.enabled} : v;
        remote.yt = now;
        return now;
      });
    } finally {
      setYtBusy(false);
    }
  }, []);

  const qualityLabel =
    QUALITIES.find(q => q.value === settings.audioQuality)?.label ??
    'Very High';
  const folder = downloads?.path || downloads?.download_dir || '';

  /** System folder picker -> backend. The backend refuses an unwritable folder,
   *  so a bad pick fails loudly here instead of silently failing downloads. */
  const pickDownloadFolder = useCallback(async () => {
    const native = NativeModules.Backend as {
      pickFolder?: () => Promise<string>;
    };
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
      setDownloads(d => {
        remote.downloads = {...(d ?? {}), ...res};
        return remote.downloads;
      });
      toast('Download folder updated');
    } catch {
      toast('Could not change the folder');
    }
  }, []);

  /** Clear the custom folder — downloads go back to the default location. */
  const useDefaultFolder = useCallback(async () => {
    try {
      const res = await setDownloadsDir('');
      setDownloads(d => {
        remote.downloads = {...(d ?? {}), ...res};
        return remote.downloads;
      });
      toast('Using the default download folder');
    } catch {
      toast('Could not reset the folder');
    }
  }, []);

  const openDownloadFolder = useCallback(async () => {
    const native = NativeModules.Backend as {
      openFolder?: (p: string) => Promise<boolean>;
    };
    const path = folder || downloads?.download_dir || downloads?.path || '';
    if (typeof native.openFolder !== 'function') {
      toast('Opening the folder needs the newest APK.');
      return;
    }
    if (!path) {
      toast('No download folder yet');
      return;
    }
    try {
      if (!(await native.openFolder(path))) {
        toast('No file manager on this device');
      }
    } catch {
      toast('Could not open the folder');
    }
  }, [folder, downloads]);

  const doReset = useCallback(() => {
    resetSettings();
    setResetOpen(false);
    toast('Settings reset to defaults');
  }, []);

  /**
   * Clear cache — a real one, not a placebo button.
   *
   * Backend side drops resolved stream URLs, lyrics, home rows and the files in
   * the app's cache directory; app side drops search history. Downloads,
   * playlists and likes are deliberately untouched: the whole point of the
   * button is that it's safe to press.
   */
  const doClearCache = useCallback(async () => {
    setCacheOpen(false);
    setClearing(true);
    try {
      const freed = await clearBackendCache();
      clearSearchHistory();
      remote.cacheBytes = 0;
      setCacheBytes(0);
      toast(freed > 0 ? `Cleared ${formatBytes(freed)}` : 'Cache cleared');
      // Re-read rather than assume zero — Android may hold files open.
      getCacheSize()
        .then(r => {
          remote.cacheBytes = r.bytes;
          setCacheBytes(r.bytes);
        })
        .catch(() => {});
    } catch {
      toast("Couldn't clear the cache");
    } finally {
      setClearing(false);
    }
  }, []);

  // Real check: asks GitHub for the latest release. A newer one raises the
  // in-app update popup (UpdateModal); the RESULT of a manual check shows inline
  // in the row (updateStatusText) — no toasts, so spamming the button can't pile
  // up a stack of notifications. The spinning icon is the whole feedback.
  const update = useUpdate();
  const checking = update.phase === 'checking';
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!checking) {
      spin.stopAnimation();
      spin.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 800,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [checking, spin]);
  const spinDeg = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });
  const checkUpdates = useCallback(() => checkUpdate(), []);

  /**
   * Land ON the update rather than at the top of the list.
   *
   * The dot said "there is an update"; tapping it opened Settings and left you
   * to scroll eight sections looking for it. The short delay lets the overlay
   * finish appearing first — scrolling a view that is still animating in lands
   * in the wrong place.
   */
  useEffect(() => {
    if (focus !== 'update') {
      return;
    }
    const t = setTimeout(() => {
      scrollRef.current?.scrollTo({
        y: Math.max(0, updateY.current - 80),
        animated: true,
      });
      setGlow(true);
    }, 260);
    // Long enough to say "this one", gone before it nags.
    const off = setTimeout(() => setGlow(false), 2100);
    return () => {
      clearTimeout(t);
      clearTimeout(off);
    };
  }, [focus]);

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
          ref={scrollRef}
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          overScrollMode="never"
          bounces={false}>
          <Section title="Listening controls">
            <ToggleRow
              label="Autoplay"
              hint="Similar songs keep playing when your queue ends"
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
          </Section>

          <Section title="Crossfade">
            <CrossfadeStepper
              value={settings.crossfadeDuration}
              onChange={secs => writeSetting('crossfadeDuration', secs)}
            />
          </Section>

          <Section title="Sleep timer">
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.rowLabel}>Stop playing</Text>
                <Text style={styles.rowHint}>
                  {sleepLabel(sleep)
                    ? `Music stops in ${sleepLabel(sleep)}`
                    : 'Fade out and stop after a while'}
                </Text>
                <View style={styles.btnRow}>
                  {[15, 30, 60].map(m => (
                    <TouchableOpacity
                      key={m}
                      style={styles.ghostBtn}
                      onPress={() => startSleepTimer(m)}
                      activeOpacity={0.7}>
                      <Text style={styles.ghostBtnText}>{m}m</Text>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity
                    style={styles.ghostBtn}
                    onPress={sleepAtEndOfTrack}
                    activeOpacity={0.7}>
                    <Text style={styles.ghostBtnText}>End of track</Text>
                  </TouchableOpacity>
                  {sleep.mode !== 'off' && (
                    <TouchableOpacity
                      style={styles.ghostBtn}
                      onPress={cancelSleepTimer}
                      activeOpacity={0.7}>
                      <Text style={styles.dangerBtnText}>Cancel</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            </View>
          </Section>
          <View style={styles.tail} />
        </ScrollView>
      </View>
    );
  }

  const updateAvailable = update.info?.available === true;
  const updateStatusText =
    update.phase === 'checking'
      ? 'Checking…'
      : updateAvailable
      ? `Version ${update.info?.version} is ready to install`
      : update.phase === 'downloading'
      ? 'Keep the app open until this finishes'
      : update.phase === 'failed'
      ? 'Check failed — tap to retry'
      : update.phase === 'current'
      ? 'You are up to date'
      : 'See whether a newer version is out';

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
        {/* Order is deliberate: the things you change often first, the
              things you set once near the bottom, and the destructive one
              last and on its own. */}
        <Section title="Playback" Icon={SlidersHorizontal}>
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

        <Section title="Audio quality" Icon={Gauge}>
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
        </Section>

        <Section title="Sources" Icon={Radio}>
          {Object.keys(sources).length === 0 && (
            <Text style={styles.folderPath}>Checking sources…</Text>
          )}
          {Object.entries(sources)
            .filter(([, v]) => v.type === 'audio')
            .map(([name]) => {
              // Same tints as the track badges, so "which source is this"
              // reads the same everywhere.
              const tint = SOURCE_META[name]?.tint || C.sub;
              return name === 'youtube' ? (
                <View key={name} style={styles.row}>
                  <View style={[styles.dot, {backgroundColor: tint}]} />
                  <View style={styles.rowText}>
                    <Text style={styles.rowLabel}>YouTube</Text>
                    <Text style={styles.rowHint}>
                      {ytBusy
                        ? 'Checking this device…'
                        : yt?.supported
                        ? 'Adds YouTube as a search and download source. No sign-in needed.'
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
                  <View style={[styles.dot, {backgroundColor: tint}]} />
                  <View style={styles.rowText}>
                    <Text style={styles.rowLabel}>
                      {SOURCE_META[name]?.label ||
                        (name === 'jiosaavn' ? 'JioSaavn' : 'SoundCloud')}
                    </Text>
                    <Text style={styles.rowHint}>
                      {name === 'jiosaavn'
                        ? 'High-quality tracks and albums'
                        : 'Remixes, sets and independent uploads'}
                    </Text>
                  </View>
                  {/* Always on — these two need no setup, so the switch is a
                        frozen ON, not a status word. */}
                  <Toggle value disabled onChange={() => {}} />
                </View>
              );
            })}
        </Section>

        <Section title="Downloads" Icon={HardDrive}>
          <View style={styles.row}>
            <HardDrive size={20} color={C.text} strokeWidth={1.9} />
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>Downloads</Text>
              <Text style={styles.rowHint} numberOfLines={2}>
                {folder ||
                  (downloads?.using_fallback
                    ? 'Using private app storage'
                    : 'Not available yet')}
              </Text>
              <View style={styles.btnRow}>
                <TouchableOpacity
                  style={styles.setBtn}
                  onPress={pickDownloadFolder}
                  activeOpacity={0.85}>
                  <Text style={styles.setBtnText}>Select</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.ghostBtn}
                  onPress={openDownloadFolder}
                  activeOpacity={0.7}>
                  <Text style={styles.ghostBtnText}>Open folder</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.ghostBtn}
                  onPress={useDefaultFolder}
                  activeOpacity={0.7}>
                  <Text style={styles.ghostBtnText}>Reset to default</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>

          <View style={styles.row}>
            <Trash2 size={20} color={C.text} strokeWidth={1.9} />
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>Clear cache</Text>
              <Text style={styles.rowHint}>
                {cacheBytes == null
                  ? 'Temporary files, lyrics and search history'
                  : `${formatBytes(
                      cacheBytes,
                    )} of temporary files, lyrics and search history`}
              </Text>
              <TouchableOpacity
                style={[styles.setBtn, styles.checkBtn]}
                onPress={() => setCacheOpen(true)}
                disabled={clearing}
                activeOpacity={0.85}>
                <Text style={styles.setBtnText}>
                  {clearing ? 'Clearing…' : 'Clear'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </Section>

        <Section title="Appearance" Icon={Eye}>
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

        {/* Its OWN section, not a composite row buried in "About".
              The update was a RefreshCw icon, an "Installed" label, a version,
              a status line and a nested button all inside one styles.row —
              nothing else on this screen looked like that. And the update dot
              on the hamburger dropped you at the top of an eight-section list
              to go hunting for it; see `focus`. */}
        <View onLayout={e => (updateY.current = e.nativeEvent.layout.y)}>
          <Section
            title="Software update"
            Icon={RefreshCw}
            highlight={glow}
            footer={
              update.phase === 'failed'
                ? 'The last check could not reach GitHub. Check your connection and try again.'
                : undefined
            }>
            <Row label="App version" value={appVersion || '—'} />
            {/* ONE row, four states — check / found / downloading / failed.
                That is the pattern both iOS and Android use, and it means the
                thing you came here to press is always in the same place. */}
            <TouchableOpacity
              style={styles.row}
              activeOpacity={0.7}
              onPress={updateAvailable ? startUpdateInstall : checkUpdates}
              disabled={checking || update.phase === 'downloading'}>
              <Animated.View style={{transform: [{rotate: spinDeg}]}}>
                <RefreshCw
                  size={19}
                  color={updateAvailable ? C.accent : C.sub}
                  strokeWidth={2}
                />
              </Animated.View>
              <View style={styles.rowText}>
                <Text
                  style={[
                    styles.rowLabel,
                    updateAvailable && styles.rowLabelAccent,
                  ]}>
                  {update.phase === 'downloading'
                    ? `Downloading… ${update.pct}%`
                    : updateAvailable
                    ? 'Download and install'
                    : 'Check for updates'}
                </Text>
                <Text style={styles.rowHint}>{updateStatusText}</Text>
              </View>
              {!updateAvailable && <ChevronRight size={17} color={C.faint} />}
            </TouchableOpacity>
            <ToggleRow
              label="Automatic updates"
              hint="Check once a day when the app opens"
              value={settings.autoUpdateCheck}
              onChange={v => writeSetting('autoUpdateCheck', v)}
            />
          </Section>
        </View>

        {/* Shortcuts used to live here as well as in the drawer. One home
              each: gestures are in the drawer, this screen is settings. */}
        <Section title="About" Icon={Info}>
          <TouchableOpacity
            style={styles.row}
            activeOpacity={0.7}
            onPress={() => Linking.openURL(DOCS_URL).catch(() => {})}>
            <Text style={[styles.rowLabel, styles.rowText]}>
              Help &amp; documentation
            </Text>
            <ExternalLink size={18} color={C.faint} />
          </TouchableOpacity>
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

      <ConfirmModal
        visible={cacheOpen}
        title="Clear cache?"
        message="Frees temporary files, saved lyrics and your search history. Downloads, playlists and liked songs are not touched."
        confirmLabel="Clear"
        onConfirm={doClearCache}
        onCancel={() => setCacheOpen(false)}
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
  section: {paddingTop: 22},
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: S.gutter + 4,
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 11.5,
    fontWeight: '700',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    color: C.faint,
  },
  card: {
    marginHorizontal: S.gutter,
    borderRadius: 12,
    backgroundColor: C.surface,
    overflow: 'hidden',
  },
  // A brief accent ring, for "this is the thing you came here for".
  cardHighlight: {borderWidth: 1.5, borderColor: C.accent},
  sectionFooter: {
    ...T.sub,
    color: C.faint,
    paddingHorizontal: S.gutter + 4,
    paddingTop: 7,
    lineHeight: 16,
  },
  sep: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: C.border,
    marginLeft: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 13,
    gap: 14,
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 14,
    backgroundColor: C.surfaceHi,
  },
  choiceOn: {color: C.accent},
  rowText: {flex: 1, minWidth: 0},
  rowLabel: {...T.body, color: C.text},
  rowLabelAccent: {color: C.accent},
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
  dot: {width: 8, height: 8, borderRadius: 4},
  btnRow: {flexDirection: 'row', gap: 10, marginTop: 12},
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
  ghostBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
  },
  ghostBtnText: {color: C.sub, fontWeight: '700', fontSize: 13},
  dangerBtnText: {color: C.danger, fontWeight: '700', fontSize: 13},
  updateHead: {flexDirection: 'row', justifyContent: 'space-between'},
  checkBtn: {alignSelf: 'flex-start', marginTop: 12},
});
