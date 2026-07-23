/**
 * Global toasts.
 *
 * Any module can call toast('…') without holding a component reference; the
 * <Toaster /> mounted once in App renders them. Messages show ONE AT A TIME and
 * queue, so three quick actions read as three confirmations in sequence instead
 * of piling on top of each other.
 *
 * The WebView version rode on a window CustomEvent; React Native has no window,
 * so the transport is a module-level store instead. Same behaviour.
 */
import {useSyncExternalStore} from 'react';

export type ToastItem = {id: number; message: string};

const SHOW_MS = 2200;
const GAP_MS = 180;

let current: ToastItem | null = null;
let nextId = 0;
const queue: string[] = [];
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  listeners.forEach(l => l());
}

function pump() {
  const message = queue.shift();
  if (message === undefined) {
    current = null;
    timer = null;
    emit();
    return;
  }
  current = {id: ++nextId, message};
  emit();
  timer = setTimeout(() => {
    current = null;
    emit();
    timer = setTimeout(pump, GAP_MS);
  }, SHOW_MS);
}

export function toast(message: string): void {
  if (!message) {
    return;
  }
  queue.push(String(message));
  if (!timer) {
    pump();
  }
}

export function useToast(): ToastItem | null {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
