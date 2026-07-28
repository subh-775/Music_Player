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

type UpdaterNative = {
  check?: () => Promise<boolean>;
  install?: () => void;
};

const native = (NativeModules.Updater ?? {}) as UpdaterNative;

export const updateSupported = typeof native.check === 'function';

export type UpdateInfo = {available: boolean; version: string; notes: string};
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'current'
  | 'found'
  | 'downloading'
  | 'failed';

type UpdateState = {phase: UpdatePhase; info: UpdateInfo | null; pct: number};

let state: UpdateState = {phase: 'idle', info: null, pct: 0};
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
    state = {...state, info: res, phase: res?.available ? 'found' : 'current'};
    emit();
  });
  emitter.addListener('mp.update.progress', (p: number) => {
    if (p < 0) {
      state = {...state, phase: 'failed'};
      emit();
      return;
    }
    state = {...state, pct: p, phase: 'downloading'};
    emit();
  });
}

/** Kick a silent check. Safe to call repeatedly (launch + opening Settings). */
export function checkUpdate(): void {
  ensureRegistered();
  // Ignore a re-tap while a check or download is already in flight — that
  // repeat was what stacked a pile of "checking…" toasts.
  if (!updateSupported || state.phase === 'checking' || state.phase === 'downloading') {
    return;
  }
  state = {...state, phase: 'checking'};
  emit();
  native.check?.().catch(() => {
    state = {...state, phase: 'idle'};
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
