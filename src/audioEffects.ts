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
import {diag} from './diag';

type AudioNative = {
  getCapabilities?: () => Promise<EqCapabilities>;
  setEqualizer?: (enabled: boolean, gainsDb: number[]) => Promise<boolean>;
  setNormalize?: (enabled: boolean) => Promise<boolean>;
  setCrossfade?: (spanMs: number) => Promise<boolean>;
  setPauseAtEndOfTrack?: (on: boolean) => Promise<boolean>;
  stopCrossfade?: () => Promise<boolean>;
  fadeOutPlayer?: (durationMs: number) => Promise<boolean>;
  fadeInPlayer?: (durationMs: number) => Promise<boolean>;
  restorePlayerVolume?: () => Promise<boolean>;
  getDiagnostics?: () => Promise<AudioDiagnostics>;
};

export type AudioDiagnostics = {
  serviceBound?: boolean;
  audioSession?: number;
  effectsAttached?: boolean;
  attachedSession?: number;
  eqEnabled?: boolean;
  bands?: number;
  loudnessEnabled?: boolean;
  playerReachable?: boolean;
  lastError?: string;
};

/** Native's own account of why the effects are or aren't working. */
export async function getAudioDiagnostics(): Promise<AudioDiagnostics | null> {
  try {
    return (await native.getDiagnostics?.()) ?? null;
  } catch {
    return null;
  }
}

export type EqCapabilities = {
  available: boolean;
  bands: number;
  minDb?: number;
  maxDb?: number;
  /** Native's own words for why not, when `available` is false. */
  reason?: string;
};

const native = (NativeModules.Audio ?? {}) as AudioNative;

/** False on a build without the native module — the UI says so rather than
 *  offering sliders that quietly do nothing. */
export const eqSupported = typeof native.setEqualizer === 'function';

/**
 * The crossfade length, handed to the native scheduler (AudioModule.cfStep).
 *
 * That is the whole of the JS side now. The schedule used to be JS timers,
 * which Android stops the moment the screen goes off — so crossfade only ever
 * happened with the app open. Native, it runs on every automatic transition.
 */
export async function setCrossfade(spanMs: number): Promise<void> {
  try {
    await native.setCrossfade?.(Math.max(0, Math.round(spanMs)));
  } catch {
    /* an APK without the scheduler — plain cuts, still correct */
  }
}

/**
 * Pause on the last frame of the current song instead of moving to the next.
 * ExoPlayer's own setPauseAtEndOfMediaItems, so it is exact and it works with
 * the screen off. False when the engine is not reachable.
 */
export async function setPauseAtEndOfTrack(on: boolean): Promise<boolean> {
  try {
    return (await native.setPauseAtEndOfTrack?.(on)) ?? false;
  } catch {
    return false;
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

/** Fade the playing track down over `durationMs` (native; self-restoring). */
export async function fadeOutPlayer(durationMs: number): Promise<void> {
  try {
    await native.fadeOutPlayer?.(durationMs);
  } catch {
    /* older APK without the native ramp — no fade, full volume, still correct */
  }
}

/**
 * Ramp UP over `durationMs` at the start of a track (native; self-restoring).
 *
 * Awaited on purpose at the one call site: the promise resolves only after the
 * native side has already dropped the volume to its floor, so awaiting it is
 * what guarantees the floor is in place BEFORE play() is called. Fire-and-forget
 * would race play() and produce a dip after the first audible moment, which is
 * worse than no fade at all.
 *
 * On an older APK without the method this resolves immediately and playback
 * starts at full volume — the pre-existing behaviour, not a broken one.
 */
export async function fadeInPlayer(durationMs: number): Promise<void> {
  try {
    await native.fadeInPlayer?.(durationMs);
  } catch {
    /* no native ramp in this build — full volume, still correct */
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

/**
 * Send the current settings to the native effects. Safe to call often.
 *
 * Failures are logged rather than swallowed. A device CAN legitimately refuse
 * effects on an offloaded session and playback must continue regardless — but
 * silently returning false is what made "the EQ does nothing" impossible to
 * diagnose without a cable.
 */
export async function applyAudioEffects(): Promise<void> {
  const settings = readSettings();
  try {
    const ok = await native.setEqualizer?.(
      !!settings.eqEnabled,
      resolveGains(settings),
    );
    if (ok === false) {
      const d = await getAudioDiagnostics();
      diag('eq', `setEqualizer refused — ${d?.lastError || 'no reason given'}`);
    } else if (settings.eqEnabled) {
      diag('eq', `applied (${resolveGains(settings).join(',')})`);
    }
  } catch (e) {
    diag('eq', `setEqualizer threw: ${String(e)}`);
  }
  try {
    const ok = await native.setNormalize?.(!!settings.normalizeVolume);
    if (ok === false) {
      diag('eq', 'setNormalize refused');
    }
  } catch (e) {
    diag('eq', `setNormalize threw: ${String(e)}`);
  }
}
