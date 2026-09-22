/**
 * Which mark the app wears on the home screen.
 *
 * Every icon is an `activity-alias` in the manifest pointing at the same
 * MainActivity, and switching enables one and disables the rest — core Android,
 * identical on every device. What is NOT identical is how quickly the launcher
 * notices, which is why choosing one asks about a restart rather than claiming
 * to be done. See IconModule.kt for the ordering rules and the OEM behaviour.
 *
 * The native side is the only source of truth here. Keeping a copy in a store
 * would drift the moment anything changed the component state from outside —
 * an adb command, a restore, a reinstall — and a settings screen showing the
 * wrong icon as selected is worse than one that has to ask.
 */
import {NativeModules} from 'react-native';

type IconNative = {
  current?: () => Promise<string>;
  set?: (key: string) => Promise<boolean>;
  restart?: () => Promise<boolean>;
};

const native = (NativeModules.AppIcon ?? {}) as IconNative;

export type AppIconKey = 'default' | 'midnight';

export type AppIconOption = {
  key: AppIconKey;
  label: string;
  /** Shown in the picker. The launcher gets its own copy from the manifest —
   *  this is only the preview. */
  preview: number;
};

export const APP_ICONS: AppIconOption[] = [
  {
    key: 'default',
    label: 'Classic',
    preview: require('./assets/app-icon.png'),
  },
  {
    key: 'midnight',
    label: 'Midnight',
    preview: require('./assets/app-icon-bl.png'),
  },
];

/** True when this build has the native module — an older APK does not, and the
 *  picker hides itself rather than offering a control that cannot work. */
export function appIconSupported(): boolean {
  return typeof native.set === 'function';
}

/** Which icon is live. Falls back to 'default', which is what the manifest
 *  ships enabled, so a failure here never renders the picker blank. */
export async function currentAppIcon(): Promise<AppIconKey> {
  try {
    const key = await native.current?.();
    return key === 'midnight' ? 'midnight' : 'default';
  } catch {
    return 'default';
  }
}

/**
 * Relaunch the app so the launcher re-reads its shortcut.
 *
 * This ENDS the process, and with it whatever is playing, so it is only ever
 * called from a confirmation the user pressed themselves.
 */
export async function restartApp(): Promise<void> {
  try {
    await native.restart?.();
  } catch {
    /* nothing to do — the icon is already switched either way */
  }
}

/**
 * Switch the icon. Resolves true when something actually changed — false means
 * it was already the live one, and the caller should not then ask for a restart
 * nobody needs.
 */
export async function setAppIcon(key: AppIconKey): Promise<boolean> {
  if (!appIconSupported()) {
    return false;
  }
  return (await native.set?.(key)) ?? false;
}
