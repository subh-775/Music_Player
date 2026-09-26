/**
 * Usage statistics: the app's own events, sent through Firebase by
 * AnalyticsModule.kt. Firebase adds active users, sessions, app version and
 * country/city by itself.
 *
 * Fire-and-forget: Firebase queues events on the phone and uploads them in
 * batches, so a call here costs one bridge message and never waits on the
 * network. A build without a Firebase config (see AnalyticsModule.kt) has
 * the module but drops everything.
 */
import {NativeModules} from 'react-native';
import type {Track} from './backend';

/** What is collected, in the words the app shows people: once as a notice,
 *  and always in Settings. There is no switch; this is the disclosure. */
export const ANALYTICS_NOTE =
  'Relaxify sends usage statistics to help improve the app: songs played, ' +
  'searches, downloads, errors, the app version and your approximate location ' +
  '(country and city). They are linked to an anonymous ID for this phone, ' +
  'never to your name, account or contacts.';

type AnalyticsNative = {
  log?: (name: string, params: Record<string, string | number>) => void;
};

const native = (NativeModules.Analytics ?? {}) as AnalyticsNative;

export function logEvent(
  name: string,
  params: Record<string, string | number> = {},
): void {
  try {
    native.log?.(name, params);
  } catch {}
}

/** A song, as event parameters. */
export function songParams(t: Track): Record<string, string> {
  return {
    title: String(t.title ?? ''),
    artist: String(t.artist ?? ''),
    source: String(t.primary_source ?? t.playable_source ?? ''),
  };
}

/**
 * JS errors that reach the top, as `app_error` events, then on to the
 * handler that was already there (the red box in debug, the crash in
 * release). Installed once at startup.
 */
export function reportErrors(): void {
  const eu = (global as any).ErrorUtils;
  if (!eu?.getGlobalHandler) {
    return;
  }
  const previous = eu.getGlobalHandler();
  eu.setGlobalHandler((e: unknown, fatal?: boolean) => {
    logEvent('app_error', {
      message: String((e as Error)?.message ?? e),
      fatal: fatal ? 1 : 0,
    });
    previous?.(e, fatal);
  });
}
