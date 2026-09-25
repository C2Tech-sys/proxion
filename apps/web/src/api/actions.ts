import { USE_FIXTURES } from '@/api/client';
import {
  fixtureGuestAction,
  fixtureUpdateGuestConfig,
  fixtureCreateSnapshot,
  fixtureDeleteSnapshot,
  fixtureRollbackSnapshot,
  fixtureMigrateGuest,
  fixtureMigratePrecheck,
  fixtureNodeAction,
} from '@/api/actionsFixture';
import type { GuestType } from '@/api/types';

/** The guest power actions this app supports -- a fixed allow-list, matching the server's own
 * (`apps/server/src/actions/routes.ts`). `reset`/`suspend`/`resume` only apply to `qemu` guests. */
export type GuestAction = 'start' | 'shutdown' | 'stop' | 'reboot' | 'reset' | 'suspend' | 'resume';

/** Optional body for `guestAction`: `timeout` (shutdown/reboot only) and `forceStop`
 * (shutdown only, sent to PVE as `forceStop=1`). Matches the server's own body contract. */
export interface GuestActionBody {
  timeout?: number;
  forceStop?: boolean;
}

export interface GuestActionResult {
  /** The PVE task UPID for this action, e.g. for a "task started" toast or the Tasks drawer. */
  upid: string;
}

/** Thrown by `guestAction` on any non-202 response. `status` is the HTTP status (401/403/4xx/502);
 * `message` is already a short, human-readable string suitable for a toast. */
export class GuestActionError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GuestActionError';
    this.status = status;
  }
}

interface GuestActionErrorBody {
  error?: string;
  message?: string;
  missing?: string;
}

/** Body for `createSnapshot`. Matches the server's own body contract for
 * `POST /api/actions/guest/:node/:type/:vmid/snapshots`. */
export interface CreateSnapshotBody {
  snapname: string;
  description?: string;
  /** Include RAM (a running-state snapshot) -- qemu only; the server 400s if sent for lxc. */
  vmstate?: boolean;
}

export interface DeleteSnapshotOptions {
  force?: boolean;
}

export interface RollbackSnapshotOptions {
  /** Start the guest after the rollback completes -- qemu only; the server 400s if sent for lxc. */
  start?: boolean;
}

export interface SnapshotActionResult {
  /** The PVE task UPID for this snapshot operation, same shape as `GuestActionResult`. */
  upid: string;
}

/** A short, human-readable message for one of the server's known error shapes; falls back to
 * the server's own `message` (PVE 4xx passthrough) or the raw status line. */
function describeError(status: number, statusText: string, body: GuestActionErrorBody | undefined): string {
  if (body?.message) return body.message;
  switch (body?.error) {
    case 'writes-disabled-in-token-mode':
      return 'Read-only: signed in with a service token';
    case 'forbidden':
      return body?.missing ? `You don't have ${body.missing} on this guest` : "You don't have permission for this";
    case 'pve-unreachable':
      return 'Proxmox VE is unreachable';
    default:
      return body?.error ?? `Request failed: ${status} ${statusText}`;
  }
}

/**
 * Requests one guest power action. Real mode: `POST /api/actions/guest/:node/:type/:vmid/:action`
 * (see the server README's "Guest actions" section). Fixture mode: simulates the request and
 * flips the guest's status in the in-memory fixture resources (`actionsFixture.ts`) so the demo
 * visibly reflects the action.
 */
export async function guestAction(
  node: string,
  type: GuestType,
  vmid: number,
  action: GuestAction,
  body?: GuestActionBody,
): Promise<GuestActionResult> {
  if (USE_FIXTURES) {
    return fixtureGuestAction(node, type, vmid, action);
  }

  const res = await fetch(`/api/actions/guest/${node}/${type}/${vmid}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

  if (res.status === 202) {
    return (await res.json()) as GuestActionResult;
  }

  let errorBody: GuestActionErrorBody | undefined;
  try {
    errorBody = (await res.json()) as GuestActionErrorBody;
  } catch {
    errorBody = undefined;
  }
  throw new GuestActionError(res.status, describeError(res.status, res.statusText, errorBody));
}

/** Patch body for `updateGuestConfig`: a guest rename and/or a notes (PVE `description`) update.
 * Matches the server's own body contract for `PATCH /api/actions/guest/:node/:type/:vmid/config`. */
export interface GuestConfigPatch {
  name?: string;
  description?: string;
}

export interface GuestConfigUpdateResult {
  ok: true;
  /** Which of `name`/`description` were actually sent -- used for the query invalidations
   * (`useUpdateGuestConfig`) and, in fixture mode, mirrors the server's own response shape. */
  changed: Array<'name' | 'description'>;
}

/**
 * Requests one guest rename/notes update. Real mode: `PATCH /api/actions/guest/:node/:type/:vmid/config`
 * (see the server README's "Guest actions" section). Fixture mode: simulates the request and
 * writes the change into the in-memory fixture config and resource row (`actionsFixture.ts`), so
 * the demo visibly reflects the rename/notes.
 */
export async function updateGuestConfig(
  node: string,
  type: GuestType,
  vmid: number,
  patch: GuestConfigPatch,
): Promise<GuestConfigUpdateResult> {
  if (USE_FIXTURES) {
    return fixtureUpdateGuestConfig(node, type, vmid, patch);
  }

  const res = await fetch(`/api/actions/guest/${node}/${type}/${vmid}/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });

  if (res.status === 200) {
    return (await res.json()) as GuestConfigUpdateResult;
  }

  let errorBody: GuestActionErrorBody | undefined;
  try {
    errorBody = (await res.json()) as GuestActionErrorBody;
  } catch {
    errorBody = undefined;
  }
  throw new GuestActionError(res.status, describeError(res.status, res.statusText, errorBody));
}

/** Shared by the three snapshot functions below: reads a non-202 response's error body (best
 * effort) and throws the same `GuestActionError` shape `guestAction`/`updateGuestConfig` do. */
async function throwSnapshotError(res: Response): Promise<never> {
  let errorBody: GuestActionErrorBody | undefined;
  try {
    errorBody = (await res.json()) as GuestActionErrorBody;
  } catch {
    errorBody = undefined;
  }
  throw new GuestActionError(res.status, describeError(res.status, res.statusText, errorBody));
}

/**
 * Requests one snapshot create. Real mode:
 * `POST /api/actions/guest/:node/:type/:vmid/snapshots` (see the server README's "Guest
 * actions" section). Fixture mode: simulates the request and adds the snapshot to the in-memory
 * fixture snapshot tree (`actionsFixture.ts` / `fixtures.ts`'s `setFixtureSnapshots`).
 */
export async function createSnapshot(
  node: string,
  type: GuestType,
  vmid: number,
  body: CreateSnapshotBody,
): Promise<SnapshotActionResult> {
  if (USE_FIXTURES) {
    return fixtureCreateSnapshot(node, type, vmid, body);
  }

  const res = await fetch(`/api/actions/guest/${node}/${type}/${vmid}/snapshots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 202) {
    return (await res.json()) as SnapshotActionResult;
  }
  return throwSnapshotError(res);
}

/**
 * Requests one snapshot delete. Real mode:
 * `DELETE /api/actions/guest/:node/:type/:vmid/snapshots/:snapname` (see the server README's
 * "Guest actions" section). Fixture mode: simulates the request and removes the snapshot from
 * the in-memory fixture snapshot tree.
 */
export async function deleteSnapshot(
  node: string,
  type: GuestType,
  vmid: number,
  snapname: string,
  options?: DeleteSnapshotOptions,
): Promise<SnapshotActionResult> {
  if (USE_FIXTURES) {
    return fixtureDeleteSnapshot(node, type, vmid, snapname);
  }

  const query = options?.force ? '?force=1' : '';
  const res = await fetch(
    `/api/actions/guest/${node}/${type}/${vmid}/snapshots/${encodeURIComponent(snapname)}${query}`,
    { method: 'DELETE' },
  );

  if (res.status === 202) {
    return (await res.json()) as SnapshotActionResult;
  }
  return throwSnapshotError(res);
}

/**
 * Requests one snapshot rollback. Real mode:
 * `POST /api/actions/guest/:node/:type/:vmid/snapshots/:snapname/rollback` (see the server
 * README's "Guest actions" section). Fixture mode: simulates the request and moves the "current"
 * (live-state) row in the in-memory fixture snapshot tree under the chosen snapshot.
 */
export async function rollbackSnapshot(
  node: string,
  type: GuestType,
  vmid: number,
  snapname: string,
  options?: RollbackSnapshotOptions,
): Promise<SnapshotActionResult> {
  if (USE_FIXTURES) {
    return fixtureRollbackSnapshot(node, type, vmid, snapname, options);
  }

  const res = await fetch(
    `/api/actions/guest/${node}/${type}/${vmid}/snapshots/${encodeURIComponent(snapname)}/rollback`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(options ?? {}),
    },
  );

  if (res.status === 202) {
    return (await res.json()) as SnapshotActionResult;
  }
  return throwSnapshotError(res);
}

/** Body for `migrateGuest`. Matches the server's own body contract for
 * `POST /api/actions/guest/:node/:type/:vmid/migrate`. `withLocalDisks` is qemu-only;
 * `restart` is lxc-only -- the server 400s if either is sent for the other guest type. */
export interface MigrateGuestBody {
  target: string;
  online?: boolean;
  /** qemu only. */
  withLocalDisks?: boolean;
  /** lxc only. */
  restart?: boolean;
  bwlimit?: number;
  targetStorage?: string;
}

/** One node's migrate-precheck disqualification, as `MigratePrecheck.notAllowedNodes` reports
 * it -- matches the server's own normalised shape (`apps/server/src/actions/migrateRoutes.ts`). */
export interface MigratePrecheckNodeReason {
  unavailableStorages: string[];
  blockingHaResources: string[];
}

/** The guest's migrate precheck, normalised the same way for both guest types by the server
 * (real PVE's own qemu/lxc migrate-precheck endpoints report different, hyphenation-inconsistent
 * shapes -- see `migrateRoutes.ts`). lxc always reports empty `localDisks`/`localResources`,
 * since PVE's own lxc precheck doesn't report either. */
export interface MigratePrecheck {
  running: boolean;
  allowedNodes: string[];
  notAllowedNodes: Record<string, MigratePrecheckNodeReason>;
  localDisks: Array<{ volid: string; size: number; cdrom: boolean; isUnused: boolean }>;
  localResources: string[];
}

/**
 * Requests one guest migrate. Real mode: `POST /api/actions/guest/:node/:type/:vmid/migrate`
 * (see the server README's "Guest actions" section). Fixture mode: simulates the request and
 * moves the guest to the target node in the in-memory fixture resources (`actionsFixture.ts` /
 * `fixtures.ts`'s `setFixtureGuestNode`).
 */
export async function migrateGuest(
  node: string,
  type: GuestType,
  vmid: number,
  body: MigrateGuestBody,
): Promise<GuestActionResult> {
  if (USE_FIXTURES) {
    return fixtureMigrateGuest(node, type, vmid, body);
  }

  const res = await fetch(`/api/actions/guest/${node}/${type}/${vmid}/migrate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 202) {
    return (await res.json()) as GuestActionResult;
  }
  return throwSnapshotError(res);
}

/**
 * Requests the guest's migrate precheck, optionally against `target`. Real mode:
 * `GET /api/actions/guest/:node/:type/:vmid/migrate/precheck` (`?target=<node>` when given -- see
 * the server README's "Guest actions" section). PVE's own precheck endpoint accepts an absent
 * `target` too, reporting cluster-wide `allowedNodes`/`notAllowedNodes` either way -- omitting it
 * is how `MigrateGuestDialog` learns every node's eligibility before any target is chosen.
 * Fixture mode: a synthetic, demo-friendly precheck computed from the in-memory fixture data
 * (`fixtures.ts`'s `getFixtureMigratePrecheck`).
 */
export async function getMigratePrecheck(
  node: string,
  type: GuestType,
  vmid: number,
  target: string | undefined,
): Promise<MigratePrecheck> {
  if (USE_FIXTURES) {
    return fixtureMigratePrecheck(node, type, vmid, target);
  }

  const query = target !== undefined ? `?target=${encodeURIComponent(target)}` : '';
  const res = await fetch(`/api/actions/guest/${node}/${type}/${vmid}/migrate/precheck${query}`);
  if (res.ok) {
    return (await res.json()) as MigratePrecheck;
  }
  return throwSnapshotError(res);
}

/** The node power actions this app supports -- matches the server's own allow-list
 * (`apps/server/src/actions/nodeRoutes.ts`). */
export type NodeActionCommand = 'reboot' | 'shutdown';

export interface NodeActionResult {
  ok: true;
}

/**
 * Requests one node power action. Real mode: `POST /api/actions/node/:node/:command` (see the
 * server README's "Node power" section). PVE returns nothing useful for this endpoint, so there
 * is no UPID here (unlike `guestAction`) -- just `{ ok: true }` on success. Fixture mode:
 * simulates the request; it has no fixture-visible state to change.
 */
export async function nodeAction(node: string, command: NodeActionCommand): Promise<NodeActionResult> {
  if (USE_FIXTURES) {
    return fixtureNodeAction(node, command);
  }

  const res = await fetch(`/api/actions/node/${node}/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });

  if (res.status === 202) {
    return (await res.json()) as NodeActionResult;
  }
  return throwSnapshotError(res);
}
