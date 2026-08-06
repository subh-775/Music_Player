/**
 * Graphic equalizer: band layout + presets.
 *
 * Eight bands spanning sub-bass to air. Ten is the classic layout, but eight is
 * what fits a phone screen as draggable sliders without each one becoming a
 * 20px target, and the extra two buy almost nothing at these widths.
 *
 * Gains are dB, clamped to ±12. Beyond that a boost just clips: the signal is
 * already at full scale, so lifting a band 15dB drives it past 0dBFS and the
 * result is distortion, not loudness.
 *
 * These frequencies are what the UI shows and what the presets are authored
 * against. They are NOT what the hardware uses — Android decides its own band
 * centres per device, and the native module interpolates this curve onto
 * whatever that device actually offers. See EqModule.
 */
export const EQ_BANDS = [60, 150, 400, 1000, 2400, 6000, 12000, 16000];
export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;

export const FLAT = [0, 0, 0, 0, 0, 0, 0, 0];

export type EqPreset = {
  id: string;
  label: string;
  /** A lucide-react-native export name. Kept beside the curve so a preset is
   *  defined in exactly one place — id, label, curve and glyph together. */
  icon: string;
  gains: number[] | null;
};

/** `custom` has no curve of its own — it holds whatever the user last dragged,
 *  which is why that lives in settings (eqGains) rather than here. */
export const EQ_PRESETS: EqPreset[] = [
  {id: 'flat', label: 'Flat', icon: 'Minus', gains: FLAT},
  {id: 'rock', label: 'Rock', icon: 'Guitar', gains: [5, 3, -1, -2, 1, 3, 4, 4]},
  {id: 'metal', label: 'Metal', icon: 'Flame', gains: [6, 4, -2, -3, 2, 5, 5, 3]},
  {id: 'pop', label: 'Pop', icon: 'Sparkles', gains: [-1, 2, 4, 4, 2, -1, -1, -2]},
  {id: 'hiphop', label: 'Hip-Hop', icon: 'Drum', gains: [7, 5, 1, -1, -1, 1, 2, 3]},
  {id: 'electronic', label: 'Electronic', icon: 'Radio', gains: [6, 4, 0, -2, 1, 2, 5, 6]},
  {id: 'classical', label: 'Classical', icon: 'Piano', gains: [4, 3, -1, -2, -1, 2, 3, 4]},
  {id: 'jazz', label: 'Jazz', icon: 'Music4', gains: [3, 2, 1, 2, -1, -1, 2, 3]},
  {id: 'vocal', label: 'Vocal', icon: 'Mic2', gains: [-3, -2, 2, 5, 5, 3, 0, -2]},
  {id: 'bass', label: 'Bass Boost', icon: 'Speaker', gains: [9, 7, 4, 1, 0, 0, 0, 0]},
  {id: 'treble', label: 'Treble Boost', icon: 'AudioLines', gains: [0, 0, 0, 0, 2, 5, 7, 8]},
  {id: 'custom', label: 'Custom', icon: 'SlidersHorizontal', gains: null},
];

export function presetGains(id: string): number[] | null {
  return EQ_PRESETS.find(x => x.id === id)?.gains ?? null;
}

/** Always returns a usable 8-band array — a stored value can be short or junk. */
export function normalizeGains(gains: number[] | null | undefined): number[] {
  return EQ_BANDS.map((_, i) => {
    const v = Number(gains?.[i]);
    if (!Number.isFinite(v)) {
      return 0;
    }
    return Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, v));
  });
}

type EqSettings = {
  eqEnabled?: boolean;
  eqPreset?: string;
  eqGains?: number[] | null;
};

/**
 * The curve the user has SHAPED, whether or not the effect is switched on.
 *
 * This is what the sliders and the preset chips must draw from. Drawing them
 * from resolveGains meant that with the equalizer off, every slider sat at zero
 * and no preset chip lit up — so tapping "Bass Boost" moved nothing on screen
 * and changed nothing in the sound. The screen looked broken because, visibly,
 * it did nothing.
 */
export function shapedGains(settings: EqSettings): number[] {
  const preset = presetGains(settings?.eqPreset || 'flat');
  return normalizeGains(preset || settings?.eqGains);
}

/** The curve actually SENT to the hardware. Off means flat, always. */
export function resolveGains(settings: EqSettings): number[] {
  if (!settings?.eqEnabled) {
    return FLAT;
  }
  return shapedGains(settings);
}

export function isFlat(gains: number[]): boolean {
  return (gains || []).every(g => Math.abs(g) < 0.01);
}

/** Short axis label: 60, 400, 1k, 16k. */
export function bandLabel(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz);
}
