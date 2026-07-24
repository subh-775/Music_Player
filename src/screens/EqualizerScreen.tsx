/**
 * The equalizer: a preset row over eight draggable bands.
 *
 * Two behaviours carried over from the WebView build, both easy to miss and
 * both the difference between an EQ that feels considered and one that fights
 * you:
 *   - dragging any band lands you in Custom, seeded from what is ON SCREEN
 *   - entering Custom from a preset carries that preset's curve across, so the
 *     sliders don't snap to flat the moment you tap Custom
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Dimensions,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import * as Lucide from 'lucide-react-native';
import {ChevronLeft} from 'lucide-react-native';
import {C, S, T} from '../theme';
import {
  EQ_BANDS,
  EQ_MAX_DB,
  EQ_MIN_DB,
  EQ_PRESETS,
  bandLabel,
  normalizeGains,
  presetGains,
  resolveGains,
} from '../eq';
import {useSettings, writeSetting, writeSettings} from '../store';
import {
  applyAudioEffects,
  eqSupported,
  getEqCapabilities,
  type EqCapabilities,
} from '../audioEffects';
import {Toggle} from '../components/Toggle';

/** Renders a preset's glyph by name — the preset list owns which icon it uses,
 *  so adding a preset never means editing this screen too. */
function PresetIcon({name, color}: {name: string; color: string}) {
  const Icon = (Lucide as unknown as Record<string, typeof ChevronLeft>)[name];
  return Icon ? <Icon size={19} color={color} /> : null;
}

const SLIDER_H = 150;

export function EqualizerScreen({onClose}: {onClose: () => void}) {
  const settings = useSettings();
  const [caps, setCaps] = useState<EqCapabilities | null>(null);

  useEffect(() => {
    getEqCapabilities().then(setCaps);
  }, []);

  // Every change goes straight to the native effects.
  useEffect(() => {
    applyAudioEffects();
  }, [settings.eqEnabled, settings.eqPreset, settings.eqGains]);

  const gains = useMemo(() => resolveGains(settings), [settings]);

  const setBand = useCallback(
    (i: number, db: number) => {
      const next = normalizeGains(gains);
      next[i] = Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, db));
      // Dragging a band IS an explicit intent to shape the sound, so this one
      // does turn the equalizer on.
      writeSettings({eqEnabled: true, eqPreset: 'custom', eqGains: next});
    },
    [gains],
  );

  const pickPreset = useCallback(
    (id: string) => {
      const curve = presetGains(id);
      writeSettings({
        // Deliberately NOT flipping eqEnabled here. Choosing a preset is
        // picking a shape, not switching the effect on — auto-enabling meant
        // browsing the list silently changed how the music sounded.
        eqPreset: id,
        // Carry the current curve into Custom so the sliders keep their shape.
        eqGains: curve ? normalizeGains(curve) : normalizeGains(gains),
      });
    },
    [gains],
  );

  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.barBtn}>
          <ChevronLeft size={28} color={C.text} />
        </TouchableOpacity>
        <Text style={styles.barTitle}>Equalizer</Text>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.body}>
        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>Enable equalizer</Text>
            <Text style={styles.rowHint}>
              {!eqSupported
                ? 'Not available in this build — install the newest APK.'
                : caps && !caps.available
                ? 'Play something first, then come back — the effect attaches to the audio that’s running.'
                : caps
                ? `Shaping ${caps.bands} hardware bands from these eight.`
                : 'Shape the sound across eight frequency bands'}
            </Text>
          </View>
          <Toggle
            value={!!settings.eqEnabled}
            disabled={!eqSupported}
            onChange={v => {
              writeSetting('eqEnabled', v);
              applyAudioEffects();
            }}
          />
        </View>

        <View style={styles.sliders}>
          {EQ_BANDS.map((hz, i) => (
            <Band
              key={hz}
              hz={hz}
              value={gains[i]}
              disabled={!settings.eqEnabled}
              onChange={db => setBand(i, db)}
            />
          ))}
        </View>

        <Text style={styles.section}>Presets</Text>
        <View style={styles.presets}>
          {EQ_PRESETS.map(p => {
            const on = settings.eqPreset === p.id && settings.eqEnabled;
            return (
              <TouchableOpacity
                key={p.id}
                activeOpacity={0.75}
                onPress={() => pickPreset(p.id)}
                style={[styles.preset, on && styles.presetOn]}>
                <PresetIcon
                  name={p.icon}
                  color={on ? C.bg : C.sub}
                />
                <Text style={[styles.presetText, on && styles.presetTextOn]}>
                  {p.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

/** One vertical band. Drag anywhere on the column, not just the handle. */
function Band({
  hz,
  value,
  disabled,
  onChange,
}: {
  hz: number;
  value: number;
  disabled?: boolean;
  onChange: (db: number) => void;
}) {
  const [height, setHeight] = useState(SLIDER_H);
  const heightRef = useRef(SLIDER_H);
  heightRef.current = height;

  // Live value while the finger is down. Committing to settings on every move
  // re-rendered the screen and REBUILT this responder mid-gesture — which is
  // why dragging felt like tapping discrete points. The drag is local now;
  // settings get one write on release.
  const [dragDb, setDragDb] = useState<number | null>(null);
  const dragDbRef = useRef<number | null>(null);
  const disabledRef = useRef(!!disabled);
  disabledRef.current = !!disabled;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setHeight(e.nativeEvent.layout.height);
  }, []);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !disabledRef.current,
      onMoveShouldSetPanResponder: () => !disabledRef.current,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: e => {
        const h = heightRef.current || 1;
        const t = 1 - e.nativeEvent.locationY / h;
        const db = EQ_MIN_DB + t * (EQ_MAX_DB - EQ_MIN_DB);
        dragDbRef.current = db;
        setDragDb(db);
      },
      onPanResponderMove: e => {
        const h = heightRef.current || 1;
        const t = 1 - e.nativeEvent.locationY / h;
        const db = Math.max(
          EQ_MIN_DB,
          Math.min(EQ_MAX_DB, EQ_MIN_DB + t * (EQ_MAX_DB - EQ_MIN_DB)),
        );
        dragDbRef.current = db;
        setDragDb(db);
      },
      onPanResponderRelease: () => {
        if (dragDbRef.current != null) {
          changeRef.current(dragDbRef.current);
          // Keep SHOWING the released value; clearing dragDb now would flash
          // the old prop for a frame before the settings write propagates —
          // that's the "snaps back then returns" the drag had.
        }
      },
      onPanResponderTerminate: () => {
        dragDbRef.current = null;
        setDragDb(null);
      },
    }),
  ).current;

  // Once the incoming prop matches what we released, drop the local hold.
  if (dragDb != null && Math.abs(value - dragDb) < 0.5) {
    dragDbRef.current = null;
    setDragDb(null);
  }

  const shown = dragDb ?? value;
  const pct = (shown - EQ_MIN_DB) / (EQ_MAX_DB - EQ_MIN_DB);

  return (
    <View style={styles.band}>
      <Text style={styles.bandDb}>
        {shown > 0 ? '+' : ''}
        {Math.round(shown)}
      </Text>
      <View
        style={[styles.column, disabled && styles.columnOff]}
        onLayout={onLayout}
        {...pan.panHandlers}>
        <View style={styles.columnTrack} />
        <View
          style={[
            styles.columnFill,
            {height: `${Math.max(0, Math.min(1, pct)) * 100}%`},
            disabled && styles.fillOff,
          ]}
        />
        <View
          style={[
            styles.handle,
            {bottom: `${Math.max(0, Math.min(1, pct)) * 100}%`},
            disabled && styles.handleOff,
          ]}
          pointerEvents="none"
        />
      </View>
      <Text style={styles.bandHz}>{bandLabel(hz)}</Text>
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
  barBtn: {padding: 4},
  barTitle: {...T.screenTitle, color: C.text, fontSize: 22},
  body: {paddingBottom: 32},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: S.gutter,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
    marginTop: 10,
  },
  rowText: {flex: 1, minWidth: 0},
  rowLabel: {...T.body, color: C.text},
  rowHint: {...T.sub, color: C.sub, marginTop: 3, lineHeight: 17},
  sliders: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: S.gutter,
    paddingTop: 22,
  },
  band: {alignItems: 'center', flex: 1},
  bandDb: {
    ...T.sub,
    color: C.faint,
    fontSize: 11,
    marginBottom: 6,
    fontVariant: ['tabular-nums'],
  },
  column: {
    height: SLIDER_H,
    width: 26,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  columnOff: {opacity: 0.45},
  columnTrack: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.13)',
  },
  columnFill: {
    position: 'absolute',
    bottom: 0,
    width: 3,
    borderRadius: 2,
    backgroundColor: C.accent,
  },
  fillOff: {backgroundColor: C.faint},
  handle: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    marginBottom: -7,
    backgroundColor: C.accentBright,
  },
  handleOff: {backgroundColor: C.sub},
  bandHz: {...T.sub, color: C.faint, fontSize: 10.5, marginTop: 8},
  section: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: C.faint,
    paddingHorizontal: S.gutter,
    paddingTop: 28,
    paddingBottom: 10,
  },
  presets: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingHorizontal: S.gutter,
  },
  preset: {
    // Three per row, computed in px — a % width resolved against the screen
    // rather than the padded content box overflowed to two per row on-device.
    width: Math.floor((Dimensions.get('window').width - 2 * S.gutter - 2 * 10) / 3),
    alignItems: 'center',
    gap: 6,
    paddingVertical: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
  },
  presetOn: {backgroundColor: C.accent, borderColor: C.accent},
  presetText: {...T.sub, color: C.text, fontSize: 13},
  presetTextOn: {color: C.bg, fontWeight: '700'},
});
