/**
 * A small in-app event log.
 *
 * There is no USB debugging in the loop for this project: builds are installed
 * from a release tag and tested by people who cannot run `adb logcat`. Without
 * something like this, "the equalizer does nothing" and "the update popup
 * sometimes doesn't appear" are unfalsifiable — the app has no way to say what
 * it tried and what came back.
 *
 * Deliberately tiny: a fixed ring buffer in memory, no persistence, no upload.
 * It costs nothing when nobody opens the Diagnostics screen.
 */
const MAX = 200;

export type DiagEntry = {at: number; tag: string; msg: string};

const entries: DiagEntry[] = [];
const listeners = new Set<() => void>();
let snapshot: DiagEntry[] = [];

/** Record an event. Keep `msg` short — this is a log line, not a report. */
export function diag(tag: string, msg: string): void {
  entries.push({at: Date.now(), tag, msg});
  if (entries.length > MAX) {
    entries.splice(0, entries.length - MAX);
  }
  snapshot = [...entries].reverse(); // newest first, new identity for React
  listeners.forEach(l => l());
}

export function subscribeDiag(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function readDiag(): DiagEntry[] {
  return snapshot;
}

/** The whole log as text, for the "Copy" button. */
export function diagText(): string {
  return snapshot
    .map(e => {
      const t = new Date(e.at).toISOString().slice(11, 23);
      return `${t}  [${e.tag}] ${e.msg}`;
    })
    .join('\n');
}
