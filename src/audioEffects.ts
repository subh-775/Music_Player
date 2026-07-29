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
  startCrossfade?: (url: string, durationMs: number) => Promise<boolean>;
  crossfadePosition?: () => Promise<number>;
  stopCrossfade?: () => Promise<boolean>;
  fadeOutPlayer?: (durationMs: number) => Promise<boolean>;
  restorePlayerVolume?: () => Promise<boolean>;
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

/** True only on a build that shipped the overlap player (the crossfade half). */
export const crossfadeSupported = typeof native.startCrossfade === 'function';

/** Start the second stream: the INCOMING track, fading up over `durationMs`,
 *  played alongside RNTP's outgoing track for a real overlap. */
export async function beginCrossfade(
  url: string,
  durationMs: number,
): Promise<boolean> {
  try {
    return (await native.startCrossfade?.(url, durationMs)) ?? false;
  } catch {
    return false;
  }
}

/** How far the overlap player has reached, in seconds (-1 when idle) — used to
 *  seek RNTP to the same spot before cutting the overlap. */
export async function crossfadePosition(): Promise<number> {
  try {
    return (await native.crossfadePosition?.()) ?? -1;
  } catch {
    return -1;
  }
}

/** Cut the overlap player. Safe to call when nothing is crossfading. */
export async function endCrossfade(): Promise<void> {
  try {
    await native.stopCrossfade?.();
  } catch {
    /* nothing playing — fine */
  }
}

/**
 * Volume ramps run NATIVELY, never as a JS timer loop.
 *
 * The JS version stalled the moment Android throttled RN's timers (backgrounded
 * app / locked screen), leaving the player stuck at whatever level the ramp had
 * reached — the "volume drops on track change and never recovers" bug. The
 * native ramp runs on a Handler that keeps ticking with the screen off, and
 * restores full volume by itself if anything interrupts it.
 */
export const nativeVolumeRamp = typeof native.fadeOutPlayer === 'function';

/** Fade the playing track down over `durationMs` (native; self-restoring). */
export async function fadeOutPlayer(durationMs: number): Promise<void> {
  try {
    await native.fadeOutPlayer?.(durationMs);
  } catch {
    /* older APK without the native ramp — no fade, full volume, still correct */
  }
}

/** Cancel any ramp and put the player back to full volume immediately. */
export async function restorePlayerVolume(): Promise<void> {
  try {
    await native.restorePlayerVolume?.();
  } catch {
    /* nothing to restore */
  }
}

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
