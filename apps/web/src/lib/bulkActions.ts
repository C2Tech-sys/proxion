import { GuestActionError, type GuestAction } from '@/api/actions';
import type { GuestType } from '@/api/types';

/** The power actions the Guests list's bulk bar offers (T44) -- a subset of `GuestAction`:
 *  `reset`/`suspend`/`resume` are per-guest quick actions only (qemu-only, or otherwise not a
 *  fit for "do this to N guests at once"), so they're excluded here rather than left reachable
 *  with confusing applicability rules. */
export type BulkAction = Extract<GuestAction, 'start' | 'shutdown' | 'reboot' | 'stop'>;

/** The minimal shape `splitBulkAction`/`BulkActionDialog` need from a guest -- deliberately a
 *  subset of `GuestRow` (which satisfies it structurally) so this module stays free of any
 *  dependency on the Guests page's own row shape. */
export interface BulkGuest {
  node: string;
  type: GuestType;
  vmid: number;
  name: string;
  status: string;
  template: boolean;
}

/** A short, user-facing reason one guest was left out of a bulk action's applicable list. */
export type BulkSkipReason = 'already running' | 'not running' | 'template';

export interface BulkActionSkip<T extends BulkGuest = BulkGuest> {
  guest: T;
  reason: BulkSkipReason;
}

export interface BulkActionSplit<T extends BulkGuest = BulkGuest> {
  applicable: T[];
  skipped: BulkActionSkip<T>[];
}

/** Verb labels for the bulk bar's buttons and the confirm dialog's title/button -- a tiny,
 *  bulk-specific duplicate of `GuestActionDialog`'s own `ACTION_VERB` map (see T44's ticket: reuse
 *  by import isn't possible without touching that file, so this stays its own small constant). */
export const BULK_ACTION_VERB: Record<BulkAction, string> = {
  start: 'Start',
  shutdown: 'Shut down',
  reboot: 'Reboot',
  stop: 'Stop',
};

/**
 * Splits a set of selected guests into the ones a given bulk action actually applies to and the
 * ones it doesn't, each with a short reason (T44's applicability matrix):
 *  - `start`: only a stopped, non-template guest qualifies.
 *  - `shutdown` / `reboot`: only a running guest qualifies.
 *  - `stop`: a running or paused guest qualifies.
 * A template is always skipped (`'template'`), checked before any status rule -- a stopped
 * template would otherwise read as "applicable" for `start`, which PVE itself never allows.
 */
export function splitBulkAction<T extends BulkGuest>(guests: T[], action: BulkAction): BulkActionSplit<T> {
  const applicable: T[] = [];
  const skipped: BulkActionSkip<T>[] = [];

  for (const guest of guests) {
    if (guest.template) {
      skipped.push({ guest, reason: 'template' });
      continue;
    }

    const running = guest.status === 'running';
    const paused = guest.status === 'paused';
    const stopped = !running && !paused;

    let ok: boolean;
    let reason: BulkSkipReason;
    switch (action) {
      case 'start':
        ok = stopped;
        reason = 'already running';
        break;
      case 'shutdown':
      case 'reboot':
        ok = running;
        reason = 'not running';
        break;
      case 'stop':
        ok = running || paused;
        reason = 'not running';
        break;
    }

    if (ok) applicable.push(guest);
    else skipped.push({ guest, reason });
  }

  return { applicable, skipped };
}

export interface BulkRunResult<T> {
  item: T;
  ok: boolean;
  /** Present only when `ok` is `false` -- a short, sanitised message (see
   *  `sanitizeBulkActionError`), never the raw thrown value. */
  error?: string;
}

/**
 * Runs `fn` once per item in `items`, at most `limit` calls in flight at a time, and never
 * rejects: a failing `fn` call is caught and recorded as that item's own `{ ok: false, error }`
 * result instead of aborting the whole run (T44 -- one guest 403ing must not stop the others from
 * starting). Results are returned in the same order as `items`, regardless of completion order.
 */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<BulkRunResult<T>[]> {
  const results: BulkRunResult<T>[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      const item = items[index] as T;
      try {
        await fn(item);
        results[index] = { item, ok: true };
      } catch (error) {
        results[index] = { item, ok: false, error: sanitizeBulkActionError(error) };
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/** A short, human-readable message for one failed bulk-action item -- the same messages
 *  `guestAction` itself throws (`GuestActionError`, e.g. "You don't have VM.PowerMgmt on this
 *  guest"), falling back to a generic message for anything else (a network failure, a programming
 *  error) so the summary list never shows a raw `Error` stack or `[object Object]`. */
export function sanitizeBulkActionError(error: unknown): string {
  return error instanceof GuestActionError ? error.message : 'The action could not be started.';
}
