/**
 * Pushes the EQ and normalize settings down to the native effects.
 *
 * Applied on change AND on every playback start, because Android tears effects
 * down with the audio session — a session that ends when a track finishes takes
 * the equalizer with it, so re-applying is what makes the setting stick across
 * songs rather than only until the first one ends.
 */
import {NativeModules} from 'react-native';
import {resolveGains} from './eq';
import {readSettings} from './store';

type AudioNative = {
  getCapabilities?: () => Promise<EqCapabilities>;
  setEqualizer?: (enabled: boolean, gainsDb: number[]) => Promise<boolean>;
  setNormalize?: (enabled: boolean) => Promise<boolean>;
};

export type EqCapabilities = {
  available: boolean;
  bands: number;
  minDb?: number;
  maxDb?: number;
};

const native = (NativeModules.Audio ?? {}) as AudioNative;

/** False on a build without the native module — the UI says so rather than
 *  offering sliders that quietly do nothing. */
export const eqSupported = typeof native.setEqualizer === 'function';

export async function getEqCapabilities(): Promise<EqCapabilities> {
  if (typeof native.getCapabilities !== 'function') {
    return {available: false, bands: 0};
  }
  try {
    return await native.getCapabilities();
  } catch {
    return {available: false, bands: 0};
  }
}

/** Send the current settings to the native effects. Safe to call often. */
export async function applyAudioEffects(): Promise<void> {
  const settings = readSettings();
  try {
    await native.setEqualizer?.(
      !!settings.eqEnabled,
      resolveGains(settings),
    );
  } catch {
    // A device can refuse effects on an offloaded session; playback is
    // unaffected, so this must never surface as an error.
  }
  try {
    await native.setNormalize?.(!!settings.normalizeVolume);
  } catch {
    /* same */
  }
}
