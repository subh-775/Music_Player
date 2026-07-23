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
 * a headset connecting — is rare and cheap to miss by a second, whereas a
 * native event subscription is another lifecycle to get wrong. 4s is well
 * under the time it takes to notice.
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
    const id = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return name;
}
