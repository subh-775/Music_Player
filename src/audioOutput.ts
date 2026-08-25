/**
 * Where the sound is actually going — "OnePlus Nord Buds 2r", or nothing when
 * it's the phone's own speaker.
 *
 * Android is the only one that knows this, so it comes from the native side.
 * The method may be absent on an older build, in which case this reports null
 * and every caller simply renders nothing — no crash, no empty label.
 */
import {useEffect, useState} from 'react';
import {NativeModules} from 'react-native';

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
 */
export function useAudioOutput(): string | null {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      getAudioOutput().then(v => {
        if (alive) {
          setName(v);
        }
      });
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return name;
}
