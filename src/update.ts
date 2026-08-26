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
import {AppState, NativeEventEmitter, NativeModules} from 'react-native';
import {createStore} from './storage';
import {readSettings} from './store';
import {diag} from './diag';

/**
 * When the AUTOMATIC check last ran — whatever it found.
 *
 * It used to record only a confirmed all-clear, on the reasoning that a waiting
 * update should keep being re-checked. That was harmless while the check ran
 * once per launch and is not now that it also runs on every return to the
 * foreground: a "found" result and a FAILED one both left this unwritten, so
 * coming back from the notification shade fired a fresh request every time, and
 * an offline phone retried on every glance at the screen.
 *
 * Nothing is lost by recording the attempt. Once an update is found the dot is
 * already lit and `info` is already set; re-asking cannot make it more found.
 */
const lastAutoCheck = createStore<number>('mp.updateCheckedAt.v1', 0, raw =>
  typeof raw === 'number' && raw > 0 ? raw : 0,
);

/**
 * How long an all-clear is trusted for. Fifteen minutes, and it used to be a
 * DAY — which is the whole reason the dot never appeared.
 *
 * The old reasoning was that "a 'found' result never writes the timestamp, so a
 * real update still reaches everyone on their next launch". That is wrong, and
 * wrong in a way that hides the feature completely: the timestamp says when we
 * last confirmed nothing was new, and it cannot say anything about a release
 * published AFTER it. Confirm all-clear at 9am, a release lands at 11am, and
 * the app refuses to look again until 9am tomorrow — so the only way to find it
 * was to open Settings and tap Check, which calls checkUpdate() directly and
 * bypasses this. That is exactly the reported symptom.
 *
 * This window exists only to stop a burst of checks when the app is opened and
 * closed repeatedly, or resumed several times in a row. One small HTTPS GET,
 * fired 3.5s after launch and never blocking anything, is not worth hiding a
 * release behind.
 */
const RECHECK_MS = 15 * 60 * 1000;

/**
 * The version whose popup the user has already dismissed.
 *
 * Now that a check also runs on every return to the foreground, "dismiss" has
 * to mean something durable — otherwise the popup would come back every time
 * the app was resumed, which is a nag, not a notice. It suppresses only the
 * POPUP: `useUpdateAvailable` reads `info`, not `phase`, so the dot stays lit
 * and Settings still offers to install.
 */
const dismissedVersion = createStore<string>('mp.updateDismissed.v1', '', raw =>
  typeof raw === 'string' ? raw : '',
);

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
    // A version already dismissed does not re-raise the popup — but `info` is
    // still recorded, which is what keeps the dot lit and Settings offering it.
    const alreadySeen =
      !!res?.available && res.version === dismissedVersion.get();
    state = {
      ...state,
      info: res,
      error: res?.error || '',
      phase: res?.available
        ? alreadySeen
          ? 'idle'
          : 'found'
        : failed
        ? 'failed'
        : 'current',
    };
    emit();
  });
  emitter.addListener('mp.update.progress', (p: number) => {
    // -2 is a refusal, not a failure: Android will not let this app install
    // packages, so nothing was downloaded and the native side has just opened
    // the setting that fixes it. Saying "download failed" there would send
    // people looking in entirely the wrong place.
    if (p === -2) {
      diag('update', 'install permission not granted');
      state = {
        ...state,
        phase: 'failed',
        error: 'Allow this app to install unknown apps, then try again',
      };
      emit();
      return;
    }
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

/**
 * The automatic check: at launch, and every time the app comes back to the
 * foreground. Identical to checkUpdate apart from the settings switch and a
 * short debounce.
 */
export function checkUpdateOnLaunch(): void {
  if (!readSettings().autoUpdateCheck) {
    diag('update', 'auto check skipped — automatic updates are off');
    return;
  }
  if (Date.now() - lastAutoCheck.get() < RECHECK_MS) {
    diag('update', 'auto check skipped — checked a few minutes ago');
    return;
  }
  lastAutoCheck.set(Date.now());
  checkUpdate();
}

/**
 * Re-check whenever the app returns to the foreground.
 *
 * A launch-only check reaches nobody who leaves the app running. Android keeps
 * the process alive for days behind a mediaPlayback foreground service — which
 * this app always has while something is playing — so "next launch" can be next
 * week, and until then the dot the user is watching for simply never arrives.
 *
 * Registered once and never removed: the whole point is that it keeps working
 * regardless of what is on screen.
 */
let foregroundWatch = false;
export function watchForegroundUpdates(): void {
  if (foregroundWatch) {
    return;
  }
  foregroundWatch = true;
  AppState.addEventListener('change', next => {
    if (next === 'active') {
      checkUpdateOnLaunch();
    }
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

/**
 * Hide the popup for this version. NOT a permanent skip of the update — the dot
 * stays, Settings still offers it, and the next release raises the popup again.
 */
export function dismissUpdate(): void {
  if (state.info?.version) {
    dismissedVersion.set(state.info.version);
  }
  state = {...state, phase: 'idle'};
  emit();
}

/**
 * Is a newer release waiting? Reads `info`, NOT `phase`, on purpose: dismissing
 * the popup moves the phase back to idle, but the update is still there — the
 * dot on the menu is what keeps it findable afterwards.
 */
export function useUpdateAvailable(): boolean {
  return useUpdate().info?.available === true;
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
