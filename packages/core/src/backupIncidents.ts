import { type TaskLike, taskFinalState, vmidOfTask } from './tasks.js';

const HOUR_MS = 60 * 60 * 1000;

/** Default look-back window for grouping vzdump task history into incidents: 24h. */
export const DEFAULT_LOOKBACK_MS = 24 * HOUR_MS;
/** Default "did a retry heal it" window, measured from the incident's most recent failure: 6h. */
export const DEFAULT_HEAL_WINDOW_MS = 6 * HOUR_MS;
/** Default distinct-failure count at which an incident goes hard regardless of elapsed time. */
export const DEFAULT_HARD_ATTEMPTS = 3;

/** One vzdump attempt belonging to a `BackupIncident`. */
export interface BackupAttempt {
  upid: string;
  /** Unix epoch seconds. */
  starttime: number;
  /** Unix epoch seconds. Absent while the attempt is still running. */
  endtime?: number;
  status?: string;
}

export type BackupIncidentState = 'soft' | 'hard' | 'healed';

export interface BackupIncident {
  /** `backup:<node>:<vmid>:<firstFailedUpid>` -- stable across recomputes for the same run of
   * failures, so the UI can key off it. */
  id: string;
  node: string;
  vmid: string;
  state: BackupIncidentState;
  /** Every failed attempt in this run, oldest first. */
  attempts: BackupAttempt[];
  /** Unix epoch seconds. */
  firstFailedAt: number;
  /** Unix epoch seconds. */
  lastFailedAt: number;
  /** Unix epoch seconds: `lastFailedAt` + the heal window -- with no completed retry by then
   * (and none running) the incident escalates from soft to hard. A retry that lands later still
   * heals it. */
  windowEndsAt: number;
  /** Unix epoch seconds: when the healing retry finished (its `endtime`). Only set once a
   * completed OK has healed the incident. */
  healedAt?: number;
  healedByUpid?: string;
  /** Set when a vzdump for this guest, started after the last failure, is still running (no
   * `endtime` yet) -- lets the UI say "retry in progress" instead of just "waiting for a retry". */
  runningUpid?: string;
}

export interface ComputeBackupIncidentsOptions {
  /** "Now", as Unix epoch **milliseconds** (`Date.now()`'s convention) -- unlike every task
   * timestamp in this package, which is Unix epoch **seconds** (PVE's own convention). Every
   * comparison in this module is done in milliseconds, converting task times up as needed, so
   * that `lookbackMs`/`healWindowMs` (already expressed in milliseconds by every caller) never
   * have to be divided back down. */
  now: number;
  lookbackMs?: number;
  healWindowMs?: number;
  hardAttempts?: number;
}

function toMs(unixSeconds: number): number {
  return unixSeconds * 1000;
}

/**
 * Groups a task list's `vzdump` entries per `(node, vmid)` over the look-back window (ordered by
 * `starttime`) and turns each run of consecutive failures into a `BackupIncident`:
 *
 * - A failed attempt opens an incident (if none is currently open for that guest) in **soft**
 *   state; further consecutive failures attach to it as attempts.
 * - The next non-failed task for that guest (an `OK`, or a still-`running` retry) ends the run:
 *   a completed `OK` **heals** it, at the time that retry finished (`healedAt` = its `endtime`,
 *   `healedByUpid` set); a still-running task instead sets `runningUpid`. Either way, any
 *   *later* failure for the same guest starts a brand-new incident -- this function is
 *   retroactive by construction (it's recomputed from history on every call, keyed off `now`).
 * - While open, the incident is **soft** until it has `hardAttempts` (default 3) distinct
 *   failures, or until `now` is more than `healWindowMs` past its most recent failure with no
 *   retry running -- then it is **hard**. A retry that lands after the window still heals it.
 */
export function computeBackupIncidents(
  tasks: TaskLike[],
  options: ComputeBackupIncidentsOptions,
): BackupIncident[] {
  const { now } = options;
  const lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const healWindowMs = options.healWindowMs ?? DEFAULT_HEAL_WINDOW_MS;
  const hardAttempts = options.hardAttempts ?? DEFAULT_HARD_ATTEMPTS;
  const cutoffMs = now - lookbackMs;

  const groups = new Map<string, TaskLike[]>();
  for (const task of tasks) {
    if (task.type !== 'vzdump') continue;
    if (toMs(task.starttime) < cutoffMs) continue;
    const vmid = vmidOfTask(task);
    if (!vmid) continue;
    const key = `${task.node}\u0000${vmid}`;
    const list = groups.get(key);
    if (list) list.push(task);
    else groups.set(key, [task]);
  }

  const incidents: BackupIncident[] = [];

  for (const [key, groupTasks] of groups) {
    const sepIndex = key.indexOf('\u0000');
    const node = key.slice(0, sepIndex);
    const vmid = key.slice(sepIndex + 1);
    const ordered = [...groupTasks].sort((a, b) => a.starttime - b.starttime);

    let i = 0;
    while (i < ordered.length) {
      if (taskFinalState(ordered[i]!.status) !== 'error') {
        i += 1;
        continue;
      }

      const attempts: BackupAttempt[] = [toAttempt(ordered[i]!)];
      let j = i + 1;
      while (j < ordered.length && taskFinalState(ordered[j]!.status) === 'error') {
        attempts.push(toAttempt(ordered[j]!));
        j += 1;
      }
      const resolving = j < ordered.length ? ordered[j] : undefined;

      const firstFailedAt = attempts[0]!.starttime;
      const lastFailedAt = attempts[attempts.length - 1]!.starttime;
      const windowEndsAt = lastFailedAt + healWindowMs / 1000;

      let healedAt: number | undefined;
      let healedByUpid: string | undefined;
      let runningUpid: string | undefined;

      if (resolving) {
        const resolvingState = taskFinalState(resolving.status);
        if (resolvingState === 'ok') {
          // A completed successful run ALWAYS heals the incident -- the backup is good now, and
          // a standing alert for it would be exactly the stale error this rule exists to avoid.
          // It heals when the retry LANDS (its `endtime`): a forced-full retry can start minutes
          // after the failure and run for hours, and "healed at" should be when it finished.
          healedAt = resolving.endtime ?? resolving.starttime;
          healedByUpid = resolving.upid;
        } else if (resolvingState === 'running') {
          runningUpid = resolving.upid;
        }
      }

      // Severity while open: hard after `hardAttempts` failures, or once the heal window has
      // passed with no completed retry AND none in progress (a running retry is evidence the
      // backup agent is on it, so the clock alone never escalates it).
      const state: BackupIncidentState =
        healedAt !== undefined
          ? 'healed'
          : attempts.length >= hardAttempts
            ? 'hard'
            : runningUpid === undefined && now - toMs(lastFailedAt) > healWindowMs
              ? 'hard'
              : 'soft';

      incidents.push({
        id: `backup:${node}:${vmid}:${attempts[0]!.upid}`,
        node,
        vmid,
        state,
        attempts,
        firstFailedAt,
        lastFailedAt,
        windowEndsAt,
        ...(healedAt !== undefined ? { healedAt } : {}),
        ...(healedByUpid !== undefined ? { healedByUpid } : {}),
        ...(runningUpid !== undefined ? { runningUpid } : {}),
      });

      // Resume scanning after the resolving task (or right after the last attempt, if the run
      // is still open) -- a later failure for this guest always starts a brand-new incident.
      i = resolving ? j + 1 : j;
    }
  }

  // Sorted by (node, vmid, firstFailedAt) rather than left in `Map` insertion order (which
  // would otherwise depend on the input array's task order): deterministic regardless of how
  // the caller merged/ordered its task history before passing it in.
  incidents.sort((a, b) => {
    if (a.node !== b.node) return a.node < b.node ? -1 : 1;
    if (a.vmid !== b.vmid) return a.vmid < b.vmid ? -1 : 1;
    return a.firstFailedAt - b.firstFailedAt;
  });

  return incidents;
}

function toAttempt(task: TaskLike): BackupAttempt {
  return {
    upid: task.upid,
    starttime: task.starttime,
    ...(task.endtime !== undefined ? { endtime: task.endtime } : {}),
    ...(task.status !== undefined ? { status: task.status } : {}),
  };
}
