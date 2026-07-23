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
import {getDownloadStatus, startDownload, type Track} from './backend';
import {getTrackId} from './tracks';
import {toast} from './toast';

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
    const active = jobs.filter(j => j.status === 'queued' || j.status === 'downloading');
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
          job.progress = Number.isFinite(raw) ? Math.min(1, raw / 100) : job.progress;
          if (t.status === 'completed' || t.status === 'done') {
            job.status = 'done';
            job.progress = 1;
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

/** Start a download and track it. Ignores a track already in flight. */
export async function enqueueDownload(track: Track): Promise<void> {
  const id = getTrackId(track);
  if (jobs.some(j => getTrackId(j.track) === id && j.status !== 'error')) {
    return;
  }
  const res = await startDownload(track);
  if (!res.task_id) {
    toast(res.error || 'Could not start that download');
    return;
  }
  jobs = [...jobs, {taskId: res.task_id, track, progress: null, status: 'queued'}];
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
