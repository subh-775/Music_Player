/**
 * In-flight downloads, with live progress.
 *
 * The backend runs each download as a task and reports percentage on
 * /api/download/<id>, so this holds the set of tasks the user has started and
 * polls them until they finish. Without it a download was invisible until it
 * completed and popped into the folder, which reads as "nothing happened".
 *
 * Tasks live in memory only. A download that was still running when the app
 * closed is finished by the backend regardless, and the file appears on the
 * next disk scan — so persisting a stale "in progress" row would be a lie.
 */
import {useSyncExternalStore} from 'react';
import {apiUrl, getDownloadStatus, startDownload, type Track} from './backend';
import {getBestArtworkUrl, getDownloadKey} from './tracks';
import {createStore, asArray, useStoreSelector, useStoreValue} from './storage';
import {toast} from './toast';

/**
 * Artwork for downloaded songs, persisted.
 *
 * The disk scan deliberately returns no cover art (reading embedded art for
 * every file on every scan is heavy), so a scanned track arrives artless. The
 * cover IS known at the moment the download starts — the catalog track has it
 * — so it's remembered here, keyed by track identity, and laid back over the
 * scan results. Capped so it can't grow forever.
 */
const artCache = createStore<Array<[string, string]>>(
  'mp.downloadArt.v1',
  [],
  raw =>
    asArray<unknown>(raw).filter(
      (x): x is [string, string] => Array.isArray(x) && x.length === 2,
    ),
);

function rememberArtwork(track: Track): void {
  const art = getBestArtworkUrl(track);
  if (!art) {
    return;
  }
  // Keyed the way the SCAN will ask for it — see getDownloadKey. Storing this
  // under the catalog id meant the lookup below could never hit.
  const id = getDownloadKey(track);
  const rest = artCache.get().filter(([k]) => k !== id);
  const entry: [string, string] = [id, art];
  artCache.set([entry, ...rest].slice(0, 500));
}

/** Fill in artwork for disk-scanned tracks: the cover remembered at download
 *  time first, else the backend's embedded-tag extractor — which also covers
 *  songs downloaded before this cache existed. */
export function overlayDownloadArtwork(tracks: Track[]): Track[] {
  const map = new Map(artCache.get());
  return tracks.map(t => {
    if (t.artwork_url) {
      return t;
    }
    const remembered = map.get(getDownloadKey(t));
    if (remembered) {
      return {...t, artwork_url: remembered};
    }
    // Only ask the backend for embedded art when the scan says there IS some.
    // `has_embedded_art` is undefined on an older backend, in which case try
    // anyway — that is the previous behaviour, and a miss costs one 404.
    if (t.file_path && t.has_embedded_art !== false) {
      return {
        ...t,
        artwork_url: apiUrl(
          `/local/artwork?path=${encodeURIComponent(t.file_path)}`,
        ),
      };
    }
    return t;
  });
}

// ─── What's already on disk ─────────────────────────────────────────────────

/**
 * Identities of completed downloads, persisted. This is what lets a search
 * result or player button say "already downloaded" (green tick) instead of
 * cheerfully downloading the same song five times.
 */
const downloadedIds = createStore<string[]>('mp.downloadedIds.v1', [], raw =>
  asArray<string>(raw)
    .filter(x => typeof x === 'string')
    // Migrate in place. Entries written before getDownloadKey existed are
    // "title|artist|isrc"; keeping only the first two segments turns them into
    // the new key and is a no-op on anything already in that form. Without
    // this, every existing download would read as un-downloaded until the next
    // Library visit re-scanned the folder.
    .map(x => x.split('|').slice(0, 2).join('|'))
    .slice(0, 2000),
);

export function isDownloaded(track: Track | null | undefined): boolean {
  if (!track) {
    return false;
  }
  return (
    !!track.file_path || downloadedIds.get().includes(getDownloadKey(track))
  );
}

/**
 * Feed a disk scan's results in so the set reflects reality — including files
 * deleted outside the app, whose keys drop out.
 *
 * A full replace is right (the folder IS the truth) but it must not be able to
 * un-mark a download that finished seconds ago and whose file the scan simply
 * has not seen flushed yet. Anything still sitting in `jobs` as done is unioned
 * back in; those rows clear themselves 1.5s later, which is the width of the
 * race this covers.
 */
export function markDownloaded(tracks: Track[]): void {
  const scanned = tracks.map(getDownloadKey);
  const settling = jobs
    .filter(j => j.status === 'done')
    .map(j => getDownloadKey(j.track));
  const ids = Array.from(new Set([...scanned, ...settling]));
  const prev = downloadedIds.get();
  const same = prev.length === ids.length && ids.every((v, i) => v === prev[i]);
  if (!same) {
    downloadedIds.set(ids);
  }
}

export function useDownloadedIds(): string[] {
  return useStoreValue(downloadedIds);
}

/**
 * Is THIS track on disk — as a boolean subscription.
 *
 * useDownloadedIds() hands back the whole id array, so any download finishing
 * re-rendered every row that called it. This re-renders a row only when that
 * row's own answer changes.
 */
export function useIsDownloaded(track: Track | null | undefined): boolean {
  const id = track ? getDownloadKey(track) : '';
  const onDisk = !!track?.file_path;
  return useStoreSelector(
    downloadedIds,
    ids => onDisk || (!!id && ids.includes(id)),
  );
}

export type DownloadJob = {
  taskId: string;
  track: Track;
  /** 0..1, or null while the backend has only queued it. */
  progress: number | null;
  status: 'queued' | 'downloading' | 'done' | 'error';
  error?: string;
};

let jobs: DownloadJob[] = [];
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function emit() {
  jobs = [...jobs];
  listeners.forEach(l => l());
}

function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Poll every active task. Stops by itself once nothing is in flight. */
function ensurePolling() {
  if (timer) {
    return;
  }
  timer = setInterval(async () => {
    const active = jobs.filter(
      j => j.status === 'queued' || j.status === 'downloading',
    );
    if (!active.length) {
      stopPolling();
      return;
    }
    await Promise.all(
      active.map(async job => {
        try {
          const t = await getDownloadStatus(job.taskId);
          const raw = Number(t.progress);
          // The backend reports 0..100; normalise once, here.
          job.progress = Number.isFinite(raw)
            ? Math.min(1, raw / 100)
            : job.progress;
          if (t.status === 'completed' || t.status === 'done') {
            job.status = 'done';
            job.progress = 1;
            const id = getDownloadKey(job.track);
            if (!downloadedIds.get().includes(id)) {
              downloadedIds.set([...downloadedIds.get(), id]);
            }
            // Re-scan now, not on the next Library visit. Until this existed,
            // the Downloaded collection and every ⋮ sheet outside Library were
            // stale until you happened to open the tab.
            onDownloadComplete.forEach(fn => fn());
          } else if (t.status === 'failed' || t.status === 'error') {
            job.status = 'error';
            job.error = t.error;
          } else {
            job.status = 'downloading';
          }
        } catch {
          // Transient; the next tick tries again.
        }
      }),
    );
    emit();

    // Clear finished rows a moment later so the bar is seen completing.
    const settled = jobs.filter(j => j.status === 'done');
    if (settled.length) {
      setTimeout(() => {
        jobs = jobs.filter(j => j.status !== 'done');
        emit();
      }, 1500);
    }
  }, 500);
}

/**
 * Anyone who wants to know the moment a download lands.
 *
 * Library registers its disk scan here. A module-level set rather than a prop
 * chain because the thing that needs re-scanning (the Downloaded collection,
 * and every "already downloaded" tick in the app) is not on screen when the
 * download finishes — that is the whole point.
 */
const onDownloadComplete = new Set<() => void>();

/**
 * A download is gone: drop it from the registry and tell everyone.
 *
 * Deleting only removed the FILE. The id stayed in `downloadedIds`, so
 * `isDownloaded` kept saying yes, every row kept its downloaded tick, and
 * nothing re-scanned — the Library tab only rescans when it becomes visible or
 * when a download COMPLETES. That is the whole of "I deleted it and it is
 * still there, then I came back and the list was empty but the count said 1":
 * two different stale sources, neither of them the disk.
 *
 * The same listener set as a completed download, because it is the same
 * question: what is on disk changed.
 */
export function forgetDownloads(tracks: Track[]): void {
  const gone = new Set(tracks.map(getDownloadKey));
  const prev = downloadedIds.get();
  const next = prev.filter(id => !gone.has(id));
  if (next.length !== prev.length) {
    downloadedIds.set(next);
  }
  onDownloadComplete.forEach(fn => fn());
}

export function onDownloadsChanged(fn: () => void): () => void {
  onDownloadComplete.add(fn);
  return () => {
    onDownloadComplete.delete(fn);
  };
}

/** Start a download and track it. Ignores a track already in flight — and one
 *  already ON DISK, which used to be re-downloadable indefinitely. */
export async function enqueueDownload(track: Track): Promise<void> {
  const id = getDownloadKey(track);
  if (isDownloaded(track)) {
    toast('Already downloaded');
    return;
  }
  if (jobs.some(j => getDownloadKey(j.track) === id && j.status !== 'error')) {
    return;
  }
  const res = await startDownload(track);
  if (!res.task_id) {
    toast(res.error || 'Could not start that download');
    return;
  }
  rememberArtwork(track);
  jobs = [
    ...jobs,
    {taskId: res.task_id, track, progress: null, status: 'queued'},
  ];
  emit();
  ensurePolling();
}

export function useDownloadJobs(): DownloadJob[] {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => jobs,
  );
}
