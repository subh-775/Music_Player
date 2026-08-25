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

/** 'info' is the everyday confirmation bar; 'warn' is visually distinct (dark,
 *  accent-bordered) for system-ish notices like "press back again to exit". */
export type ToastKind = 'info' | 'warn';
export type ToastItem = {id: number; message: string; kind: ToastKind};

const SHOW_MS = 2200;
const GAP_MS = 180;

let current: ToastItem | null = null;
let nextId = 0;
const queue: Array<{message: string; kind: ToastKind}> = [];
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  listeners.forEach(l => l());
}

function pump() {
  const item = queue.shift();
  if (item === undefined) {
    current = null;
    timer = null;
    emit();
    return;
  }
  current = {id: ++nextId, ...item};
  emit();
  timer = setTimeout(() => {
    current = null;
    emit();
    timer = setTimeout(pump, GAP_MS);
  }, SHOW_MS);
}

export function toast(message: string, kind: ToastKind = 'info'): void {
  if (!message) {
    return;
  }
  queue.push({message: String(message), kind});
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
