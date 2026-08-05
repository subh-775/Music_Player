#!/usr/bin/env node
/**
 * `npm run dev` — the hot-reload loop, so UI work does not need a new APK.
 *
 * Install the DEBUG apk once. It carries no JS bundle: it fetches the bundle
 * from Metro on this machine over the USB cable, so every save re-renders on
 * the phone in about a second. Only Kotlin and Python changes still need a
 * rebuild.
 *
 * All this does is find adb (it is rarely on PATH on Windows), point the
 * phone's localhost:8081 at ours, and start Metro.
 */
const {execFileSync, spawn} = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 8081;

function findAdb() {
  const candidates = [
    process.env.ADB,
    process.env.ANDROID_HOME &&
      path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
    process.env.ANDROID_SDK_ROOT &&
      path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb'),
    path.join(
      os.homedir(),
      'AppData',
      'Local',
      'platform-tools',
      'platform-tools',
      'adb.exe',
    ),
    path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
    'adb',
  ].filter(Boolean);

  for (const c of candidates) {
    const withExe = process.platform === 'win32' && !c.endsWith('.exe') ? `${c}.exe` : c;
    try {
      // A bare "adb" has no path to stat — just try running it.
      if (withExe !== 'adb' && withExe !== 'adb.exe' && !fs.existsSync(withExe)) {
        continue;
      }
      execFileSync(withExe, ['version'], {stdio: 'ignore'});
      return withExe;
    } catch {
      // next candidate
    }
  }
  return null;
}

const adb = findAdb();
if (!adb) {
  console.error(
    'adb not found. Set ADB=/full/path/to/adb, or install Android platform-tools.',
  );
  process.exit(1);
}

const devices = execFileSync(adb, ['devices'], {encoding: 'utf8'})
  .split('\n')
  .slice(1)
  .filter(l => l.trim().endsWith('device'));

if (!devices.length) {
  console.error(
    'No device. Enable USB debugging, plug the phone in, and accept the prompt.',
  );
  process.exit(1);
}

// The phone's own localhost:8081 now resolves to this machine's Metro. This is
// what makes the loop work over a cable with no wifi and no IP addresses.
execFileSync(adb, ['reverse', `tcp:${PORT}`, `tcp:${PORT}`], {stdio: 'inherit'});
console.log(`adb reverse ready on ${PORT} — starting Metro.`);
console.log('Shake the phone (or `adb shell input keyevent 82`) for the dev menu.');

spawn(process.execPath, [require.resolve('react-native/cli.js'), 'start'], {
  stdio: 'inherit',
}).on('exit', code => process.exit(code ?? 0));
