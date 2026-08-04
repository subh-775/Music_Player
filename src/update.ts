/**
 * The in-app update flow, as a module-level store.
 *
 * Native (UpdateModule.kt) does the GitHub check, the APK download, and hands
 * off to the system installer. This holds the phase so the popup and the
 * Settings row read the same state, and a download in progress survives whatever
 * screen you're on (the native fetch runs on its own thread regardless).
 *
 * phase: idle | checking | current | found | downloading | failed
 */
import {useSyncExternalStore} from 'react';
import {NativeEventEmitter, NativeModules} from 'react-native';
import {diag} from './diag';

type UpdaterNative = {
  check?: () => Promise<boolean>;
  install?: () => void;
};

const native = (NativeModules.Updater ?? {}) as UpdaterNative;

export const updateSupported = typeof native.check === 'function';

export type UpdateInfo = {
  available: boolean;
  version: string;
  notes: string;
  /** Set when the check could not complete — distinct from "up to date". */
  error?: string;
  /** The version actually installed, as native sees it. */
  installed?: string;
};
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'current'
  | 'found'
  | 'downloading'
  | 'failed';

type UpdateState = {
  phase: UpdatePhase;
  info: UpdateInfo | null;
  pct: number;
  error: string;
};

let state: UpdateState = {phase: 'idle', info: null, pct: 0, error: ''};
const listeners = new Set<() => void>();

function emit() {
  state = {...state}; // new identity so useSyncExternalStore re-renders
  listeners.forEach(l => l());
}

let registered = false;
function ensureRegistered() {
  if (registered || !updateSupported) {
    return;
  }
  registered = true;
  const emitter = new NativeEventEmitter(NativeModules.Updater);
  // Never removed — the whole point is that progress lands here no matter what
  // is (or isn't) on screen.
  emitter.addListener('mp.update.result', (res: UpdateInfo) => {
    if (checkTimeout) {
      clearTimeout(checkTimeout);
      checkTimeout = null;
    }
    // "Couldn't check" is not "you're up to date". Reporting a failed check as
    // up-to-date is why an offline or rate-limited launch quietly hid a real
    // update; now it says so and can be retried.
    const failed = !res?.available && !!res?.error;
    diag(
      'update',
      res?.available
        ? `update available: ${res.version}`
        : failed
        ? `check failed: ${res.error}`
        : `up to date (${res?.installed || '?'})`,
    );
    state = {
      ...state,
      info: res,
      error: res?.error || '',
      phase: res?.available ? 'found' : failed ? 'failed' : 'current',
    };
    emit();
  });
  emitter.addListener('mp.update.progress', (p: number) => {
    if (p < 0) {
      diag('update', 'download failed');
      state = {...state, phase: 'failed', error: 'Download failed'};
      emit();
      return;
    }
    state = {...state, pct: p, phase: 'downloading'};
    emit();
  });
}

/** Kick a silent check. Safe to call repeatedly (launch + opening Settings). */
let checkTimeout: ReturnType<typeof setTimeout> | null = null;

export function checkUpdate(): void {
  ensureRegistered();
  if (!updateSupported) {
    diag('update', 'native Updater module missing from this build');
    return;
  }
  // Ignore a re-tap while a check or download is already in flight — that
  // repeat was what stacked a pile of "checking…" toasts.
  if (state.phase === 'checking' || state.phase === 'downloading') {
    return;
  }
  state = {...state, phase: 'checking', error: ''};
  emit();
  diag('update', 'checking…');

  // A dropped native event must NOT be able to strand us in 'checking'
  // forever. It could before: the guard above then made every later check a
  // silent no-op, so the popup simply never appeared again until the app was
  // restarted — exactly the "worked after clearing cache and reopening" report.
  if (checkTimeout) {
    clearTimeout(checkTimeout);
  }
  checkTimeout = setTimeout(() => {
    if (state.phase === 'checking') {
      diag('update', 'check timed out after 20s');
      state = {...state, phase: 'failed', error: 'Check timed out'};
      emit();
    }
  }, 20000);

  native.check?.().catch(e => {
    diag('update', `check threw: ${String(e)}`);
    state = {...state, phase: 'failed', error: String(e)};
    emit();
  });
}

/** Begin downloading + installing (the user still confirms the OS install). */
export function startUpdateInstall(): void {
  ensureRegistered();
  if (!updateSupported) {
    return;
  }
  state = {...state, phase: 'downloading', pct: 0};
  emit();
  native.install?.();
}

/** Hide the popup for now (a dismiss, not a permanent skip). */
export function dismissUpdate(): void {
  state = {...state, phase: 'idle'};
  emit();
}

export function useUpdate(): UpdateState {
  return useSyncExternalStore(
    l => {
      ensureRegistered();
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
