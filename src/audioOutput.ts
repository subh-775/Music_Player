/**
 * Where the sound is actually going — "OnePlus Nord Buds 2r", or nothing when
 * it's the phone's own speaker.
 *
 * Android is the only one that knows this, so it comes from the native side.
 * The method may be absent on an older build, in which case this reports null
 * and every caller simply renders nothing — no crash, no empty label.
 */
import {useEffect, useState} from 'react';
import {AppState, NativeModules} from 'react-native';

type AudioNative = {getAudioOutput?: () => Promise<string | null>};

const native = (NativeModules.Audio ?? {}) as AudioNative;

export async function getAudioOutput(): Promise<string | null> {
  if (typeof native.getAudioOutput !== 'function') {
    return null;
  }
  try {
    return await native.getAudioOutput();
  } catch {
    return null;
  }
}

/**
 * Poll for the current output device.
 *
 * Polling rather than a route-change listener because the interesting event —
 * a headset connecting — is rare, and a native event subscription is another
 * lifecycle to get wrong. Native tracks connect/disconnect order itself (see
 * AudioModule.seenAt); this just asks often enough that SWITCHING between two
 * paired headsets mid-song updates the name while you're still looking at it.
 *
 * ONE poll for every caller (the mini player, the full player and the queue
 * all show the name), and only while the app is in the foreground: nobody
 * reads the label with the screen off, and each poll kept its own timer
 * running through a whole background listening session.
 */
let current: string | null = null;
const subscribers = new Set<(name: string | null) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function tick() {
  getAudioOutput().then(v => {
    current = v;
    subscribers.forEach(s => s(v));
  });
}

function sync() {
  const want = subscribers.size > 0 && AppState.currentState !== 'background';
  if (want && !timer) {
    tick();
    timer = setInterval(tick, 1500);
  } else if (!want && timer) {
    clearInterval(timer);
    timer = null;
  }
}

AppState.addEventListener('change', sync);

export function useAudioOutput(): string | null {
  const [name, setName] = useState(current);

  useEffect(() => {
    subscribers.add(setName);
    sync();
    return () => {
      subscribers.delete(setName);
      sync();
    };
  }, []);

  return name;
}
