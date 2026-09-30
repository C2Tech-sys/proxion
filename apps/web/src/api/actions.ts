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
  fixtureUploadToStorage,
  fixtureDownloadUrlToStorage,
  fixtureQueryUrlMetadata,
  fixtureDeleteStorageContent,
  fixtureBackupGuest,
  fixtureRestoreGuest,
  fixtureRestoreNextId,
  fixtureCloneGuest,
  fixtureCloneNextId,
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

/** The storage content types a file upload / download-from-URL can target -- matches the
 * server's own allow-list (`apps/server/src/actions/storageRoutes.ts`). */
export type StorageUploadContent = 'iso' | 'vztmpl' | 'import';

export interface UploadToStorageOptions {
  file: File;
  content: StorageUploadContent;
  filename: string;
  /** Called with `(bytesSent, totalBytes)` as the upload progresses -- only the browser's
   * `XMLHttpRequest` (used here instead of `fetch`) reports upload progress at all. */
  onProgress?: (sent: number, total: number) => void;
  /** Aborts the in-flight upload (the dialog's own Cancel button) via the same `AbortController`
   * convention every other cancellable request in this app uses. */
  signal?: AbortSignal;
}

/**
 * Uploads a file (ISO, container template, or import file) to a storage. Real mode: `POST
 * /api/actions/storage/:node/:storage/upload?content=&filename=`, the browser's own
 * `multipart/form-data` body (fields `content`, then the file itself as `filename`, in that
 * order) streamed through unchanged -- see the server README's "Storage browser" section. The
 * file part's own form field is named `filename` (T35), not `file`: Proxmox's own multipart
 * parser (`pveproxy`, `PVE::APIServer::AnyEvent::file_upload_multipart`) hard-codes that exact
 * field name and takes the *target* filename from that part's `filename="..."` attribute,
 * `die`ing immediately -- "wrong field name '...' for file upload, expected 'filename'" -- for
 * any other name; there is no separate text field for it. Built with `XMLHttpRequest` rather
 * than `fetch`: only `XMLHttpRequest` reports upload progress
 * (`xhr.upload.onprogress`), which the upload dialog's progress bar needs. Fixture mode: simulates
 * progress ticks over ~1.5s then adds the item to the in-memory fixture storage content
 * (`actionsFixture.ts` / `fixtures.ts`'s `addFixtureStorageContent`).
 */
export function uploadToStorage(node: string, storage: string, options: UploadToStorageOptions): Promise<GuestActionResult> {
  if (USE_FIXTURES) {
    return fixtureUploadToStorage(node, storage, options);
  }

  return new Promise<GuestActionResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new GuestActionError(0, 'Upload cancelled'));
      return;
    }

    let xhr: XMLHttpRequest | undefined;
    let settled = false;

    // Aborts the in-flight XHR once it exists; if the abort lands before the slice-read below has
    // even resolved (no XHR yet), settle the rejection directly instead of waiting for a request
    // that will never be sent.
    options.signal?.addEventListener('abort', () => {
      if (xhr) {
        xhr.abort();
      } else if (!settled) {
        settled = true;
        reject(new GuestActionError(0, 'Upload cancelled'));
      }
    });

    // Reads the first 64 KiB of the file *before* ever opening the XHR. A `File` whose bytes the
    // browser can no longer actually read (a cloud-sync placeholder that was never fully
    // downloaded, or a file that changed/disappeared on disk after being selected) throws here --
    // without this check, the browser fails the XHR itself before it ever leaves the tab
    // (`xhr.onerror`, status 0), which used to be reported as "Proxmox VE is unreachable": wrong,
    // since Proxmox never saw the request at all.
    options.file
      .slice(0, 65536)
      .arrayBuffer()
      .then(() => {
        if (settled) return;

        const formData = new FormData();
        formData.append('content', options.content);
        // T35: the file part's own field name must be `filename` (see this function's doc
        // comment) -- not a separate text field plus a `file` part, which is what pveproxy
        // rejects every real upload for, immediately, before this server's own logic ever runs.
        formData.append('filename', options.file, options.filename);

        xhr = new XMLHttpRequest();
        // Explicit, not relied-on-as-default: a large upload over a slow link must never be cut
        // off by a client-side timeout.
        xhr.timeout = 0;
        const query = `content=${encodeURIComponent(options.content)}&filename=${encodeURIComponent(options.filename)}`;
        xhr.open('POST', `/api/actions/storage/${node}/${storage}/upload?${query}`);

        xhr.upload.onprogress = (event) => {
          options.onProgress?.(event.loaded, event.lengthComputable ? event.total : options.file.size);
        };

        xhr.onload = () => {
          settled = true;
          if (xhr!.status === 202) {
            try {
              resolve(JSON.parse(xhr!.responseText) as GuestActionResult);
            } catch {
              reject(new GuestActionError(xhr!.status, 'Invalid server response'));
            }
            return;
          }
          let errorBody: GuestActionErrorBody | undefined;
          try {
            errorBody = JSON.parse(xhr!.responseText) as GuestActionErrorBody;
          } catch {
            errorBody = undefined;
          }
          reject(new GuestActionError(xhr!.status, describeError(xhr!.status, xhr!.statusText, errorBody)));
        };
        // A status-0 `onerror` means the request never reached the network at all (blocked by a
        // proxy, a browser-side upload limit, or the connection dying mid-flight) -- it says
        // nothing about whether Proxmox itself is reachable, so the message no longer blames it.
        xhr.onerror = () => {
          settled = true;
          reject(
            new GuestActionError(
              0,
              'The upload never reached Proxion. Check that the file is readable and that any proxy in front of Proxion allows large uploads.',
            ),
          );
        };
        xhr.onabort = () => {
          settled = true;
          reject(new GuestActionError(0, 'Upload cancelled'));
        };

        xhr.send(formData);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        reject(
          new GuestActionError(
            0,
            'The browser could not read this file. If it lives in a cloud-synced folder, make sure it is fully downloaded, then try again.',
          ),
        );
      });
  });
}

/** Body for `downloadUrlToStorage`. Matches the server's own body contract for
 * `POST /api/actions/storage/:node/:storage/download-url`. */
export interface DownloadUrlToStorageBody {
  url: string;
  content: StorageUploadContent;
  filename: string;
  checksum?: string;
  checksumAlgorithm?: 'md5' | 'sha1' | 'sha224' | 'sha256' | 'sha384' | 'sha512';
  verifyCertificates?: boolean;
}

/**
 * Requests one "download from URL" onto a storage (Proxmox itself fetches `body.url`; there is no
 * client-side download here -- see the server README's "Storage browser" section for why). Real
 * mode: `POST /api/actions/storage/:node/:storage/download-url`. Fixture mode: simulates the
 * request (~1s) and adds the item to the in-memory fixture storage content, same as
 * `uploadToStorage`.
 */
export async function downloadUrlToStorage(
  node: string,
  storage: string,
  body: DownloadUrlToStorageBody,
): Promise<GuestActionResult> {
  if (USE_FIXTURES) {
    return fixtureDownloadUrlToStorage(node, storage, body);
  }

  const res = await fetch(`/api/actions/storage/${node}/${storage}/download-url`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 202) {
    return (await res.json()) as GuestActionResult;
  }
  return throwSnapshotError(res);
}

/** `queryUrlMetadata`'s result -- matches the server's own response shape
 * (`GET /api/actions/storage/:node/query-url-metadata`), all fields optional since PVE itself
 * reports only what the remote server's response headers gave it. */
export interface UrlMetadataResult {
  filename?: string;
  size?: number;
  mimetype?: string;
}

/**
 * Queries a URL's metadata (filename/size/mimetype) via PVE, without downloading it -- used by the
 * download-from-URL dialog's "Query URL" button to pre-fill the filename/size fields. Real mode:
 * `GET /api/actions/storage/:node/query-url-metadata`. Fixture mode: derives a filename from the
 * URL's own path and reports a plausible size (`actionsFixture.ts`).
 */
export async function queryUrlMetadata(node: string, url: string, verifyCertificates: boolean): Promise<UrlMetadataResult> {
  if (USE_FIXTURES) {
    return fixtureQueryUrlMetadata(node, url, verifyCertificates);
  }

  const query = `url=${encodeURIComponent(url)}&verifyCertificates=${verifyCertificates ? 'true' : 'false'}`;
  const res = await fetch(`/api/actions/storage/${node}/query-url-metadata?${query}`);
  if (res.ok) {
    return (await res.json()) as UrlMetadataResult;
  }
  return throwSnapshotError(res);
}

/** Body for `backupGuest`. Matches the server's own body contract for
 * `POST /api/actions/guest/:node/:type/:vmid/backup` -- `compress` and `prune` both default
 * server-side (`zstd`, no pruning), but `BackupNowDialog` always sends every field explicitly. */
export interface BackupGuestBody {
  storage: string;
  mode: 'snapshot' | 'suspend' | 'stop';
  compress?: 'zstd' | 'gzip' | 'lzo' | '0';
  protected?: boolean;
  notes?: string;
  prune?: boolean;
}

/**
 * Requests one guest backup (vzdump) start. Real mode:
 * `POST /api/actions/guest/:node/:type/:vmid/backup` (see the server README's "Guest actions"
 * section). Fixture mode: simulates the request (~1s) and adds a realistic backup volume to the
 * in-memory fixture storage content (`actionsFixture.ts`).
 */
export async function backupGuest(
  node: string,
  type: GuestType,
  vmid: number,
  body: BackupGuestBody,
): Promise<GuestActionResult> {
  if (USE_FIXTURES) {
    return fixtureBackupGuest(node, type, vmid, body);
  }

  const res = await fetch(`/api/actions/guest/${node}/${type}/${vmid}/backup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 202) {
    return (await res.json()) as GuestActionResult;
  }
  return throwSnapshotError(res);
}

/** Body for `restoreGuest`. Matches the server's own body contract for
 * `POST /api/actions/guest/:node/:type/:vmid/restore`. `unique` is qemu-only; `unprivileged` is
 * lxc-only -- the server 400s if either is sent for the other guest type. `targetVmid` defaults to
 * the guest's own `:vmid` server-side when omitted, but `RestoreBackupDialog` always sends it. */
export interface RestoreGuestBody {
  archive: string;
  targetVmid?: number;
  storage?: string;
  start?: boolean;
  force?: boolean;
  /** qemu only. */
  unique?: boolean;
  /** lxc only. */
  unprivileged?: boolean;
}

/**
 * Requests one guest restore-from-backup. Real mode:
 * `POST /api/actions/guest/:node/:type/:vmid/restore` (see the server README's "Guest actions"
 * section). Fixture mode: simulates the request and either flips the target guest's status
 * (restoring over an existing guest) or adds a new guest to the in-memory fixture resources
 * (restoring to a fresh id), via `actionsFixture.ts`.
 */
export async function restoreGuest(
  node: string,
  type: GuestType,
  vmid: number,
  body: RestoreGuestBody,
): Promise<GuestActionResult> {
  if (USE_FIXTURES) {
    return fixtureRestoreGuest(node, type, vmid, body);
  }

  const res = await fetch(`/api/actions/guest/${node}/${type}/${vmid}/restore`, {
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
 * The next free vmid in the cluster, for the restore dialog's "Use next free ID" button. Real
 * mode: `GET /api/actions/guest/:node/:type/:vmid/restore/nextid` (a thin proxy for PVE's own
 * `GET /cluster/nextid`, session-only). Fixture mode: one past the highest vmid currently in the
 * in-memory fixture resources (`actionsFixture.ts` / `fixtures.ts`'s `getFixtureNextId`).
 */
export async function getRestoreNextId(node: string, type: GuestType, vmid: number): Promise<number> {
  if (USE_FIXTURES) {
    return fixtureRestoreNextId();
  }

  const res = await fetch(`/api/actions/guest/${node}/${type}/${vmid}/restore/nextid`);
  if (res.ok) {
    const body = (await res.json()) as { vmid: number };
    return body.vmid;
  }
  return throwSnapshotError(res);
}

export interface DeleteStorageContentOptions {
  /** The volume's owner vmid, when it has one (e.g. a backup) -- forwarded as `?vmid=`, letting
   * the server's `Datastore.AllocateSpace` + `VM.Backup` carve-out apply for a caller who lacks
   * the full `Datastore.Allocate` privilege on the storage. `undefined` (explicit or omitted) for
   * a volume with no owner -- `useStorageDelete` always passes this key, so both spellings must be
   * accepted under `exactOptionalPropertyTypes`. */
  vmid?: number | undefined;
}

/**
 * Requests one storage content delete. Real mode:
 * `DELETE /api/actions/storage/:node/:storage/content/:volid` (`?vmid=` when given -- see the
 * server README's "Storage browser" section). Fixture mode: simulates the request and removes the
 * item from the in-memory fixture storage content (`fixtures.ts`'s `removeFixtureStorageContent`).
 */
export async function deleteStorageContent(
  node: string,
  storage: string,
  volid: string,
  options?: DeleteStorageContentOptions,
): Promise<GuestActionResult> {
  if (USE_FIXTURES) {
    return fixtureDeleteStorageContent(node, storage, volid);
  }

  const query = options?.vmid !== undefined ? `?vmid=${options.vmid}` : '';
  const res = await fetch(`/api/actions/storage/${node}/${storage}/content/${encodeURIComponent(volid)}${query}`, {
    method: 'DELETE',
  });

  if (res.status === 202) {
    return (await res.json()) as GuestActionResult;
  }
  return throwSnapshotError(res);
}

/** Body for `cloneGuest`. Matches the server's own body contract for
 * `POST /api/actions/guest/:node/:type/:vmid/clone` -- `name` is sent as `name` for qemu / mapped
 * to `hostname` for lxc server-side, so this shape is the same for both guest types. `full`
 * defaults server-side to `true` (a full clone); `false` (a linked clone) is only accepted from a
 * template source -- the server 400s (`linked-requires-template`) otherwise. */
export interface CloneGuestBody {
  newid: number;
  name?: string;
  full?: boolean;
  target?: string;
  storage?: string;
  snapname?: string;
  description?: string;
  bwlimit?: number;
}

/**
 * Requests one guest clone. Real mode: `POST /api/actions/guest/:node/:type/:vmid/clone` (see the
 * server README's "Guest actions" section). Fixture mode: simulates the request and adds a new
 * guest row -- a copy of the source guest with the new vmid/name/node -- to the in-memory fixture
 * resources (`actionsFixture.ts`).
 */
export async function cloneGuest(
  node: string,
  type: GuestType,
  vmid: number,
  body: CloneGuestBody,
): Promise<GuestActionResult> {
  if (USE_FIXTURES) {
    return fixtureCloneGuest(node, type, vmid, body);
  }

  const res = await fetch(`/api/actions/guest/${node}/${type}/${vmid}/clone`, {
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
 * The next free vmid in the cluster, for `CloneGuestDialog`'s "Use next free ID" button. Real
 * mode: `GET /api/actions/guest/:node/:type/:vmid/clone/nextid` (a thin proxy for PVE's own
 * `GET /cluster/nextid`, session-only -- same endpoint `getRestoreNextId` calls, just under the
 * clone route). Fixture mode: one past the highest vmid currently in the in-memory fixture
 * resources (`actionsFixture.ts` / `fixtures.ts`'s `getFixtureNextId`).
 */
export async function getCloneNextId(node: string, type: GuestType, vmid: number): Promise<number> {
  if (USE_FIXTURES) {
    return fixtureCloneNextId();
  }

  const res = await fetch(`/api/actions/guest/${node}/${type}/${vmid}/clone/nextid`);
  if (res.ok) {
    const body = (await res.json()) as { vmid: number };
    return body.vmid;
  }
  return throwSnapshotError(res);
}
