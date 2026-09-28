import {
  setFixtureGuestConfig,
  setFixtureGuestNode,
  setFixtureGuestStatus,
  setFixtureSnapshots,
  getFixtureMigratePrecheck,
  addFixtureStorageContent,
  removeFixtureStorageContent,
} from '@/api/fixtures';
import type { GuestType } from '@/api/types';
import type {
  CreateSnapshotBody,
  DownloadUrlToStorageBody,
  GuestAction,
  GuestActionResult,
  GuestConfigPatch,
  GuestConfigUpdateResult,
  MigrateGuestBody,
  MigratePrecheck,
  NodeActionCommand,
  NodeActionResult,
  RollbackSnapshotOptions,
  SnapshotActionResult,
  UploadToStorageOptions,
  UrlMetadataResult,
} from '@/api/actions';
import { GuestActionError } from '@/api/actions';

/** Matches the real route's own simulated latency budget closely enough to feel real, without
 * being long enough to make the demo feel slow. */
const FIXTURE_ACTION_DELAY_MS = 400;

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), FIXTURE_ACTION_DELAY_MS));
}

/** The status a fixture guest settles into after each action, for the demo's visible flip.
 * `reboot`/`reset` leave the guest `running` throughout (PVE never reports an intermediate
 * "rebooting" cluster-resource status either). */
function nextStatus(action: GuestAction): string {
  switch (action) {
    case 'start':
    case 'resume':
    case 'reboot':
    case 'reset':
      return 'running';
    case 'stop':
    case 'shutdown':
      return 'stopped';
    case 'suspend':
      return 'paused';
  }
}

let fixtureUpidSeq = 0;

/** A fake but UPID-shaped string (`UPID:<node>:...`), close enough to PVE's real format for a
 * "task <short upid>" toast and for the Tasks drawer to not look out of place, if it ever grows
 * fixture-mode task rows for these actions. */
function fakeUpid(node: string, vmid: number, action: GuestAction): string {
  return fakeUpidFor(node, vmid, action);
}

/** Shared by `fakeUpid` above and the three snapshot fixtures below -- `op` is a PVE task type
 * string (`snapshot`, `delsnapshot`, `qmrollback`/`vzrollback`, or a guest power action). */
function fakeUpidFor(node: string, vmid: number, op: string): string {
  fixtureUpidSeq += 1;
  const seq = fixtureUpidSeq.toString(16).padStart(8, '0');
  return `UPID:${node}:${seq}:00000000:00000000:${op}:${vmid}:demo@pve!fixtures:`;
}

/** Fixture-mode implementation of `guestAction` (see `src/api/actions.ts`): no real request,
 * just a simulated delay and an in-memory status flip on the shared fixture resources. The
 * request body (`timeout`/`forceStop`) has no fixture-visible effect and is intentionally not
 * accepted here -- `guestAction` never passes it through in fixture mode. */
export async function fixtureGuestAction(
  node: string,
  type: GuestType,
  vmid: number,
  action: GuestAction,
): Promise<GuestActionResult> {
  setFixtureGuestStatus(node, type, vmid, nextStatus(action));
  return delay({ upid: fakeUpid(node, vmid, action) });
}

/** Fixture-mode implementation of `updateGuestConfig` (see `src/api/actions.ts`): no real
 * request, just a simulated delay and an in-memory write to the fixture config/resources
 * (`setFixtureGuestConfig`), so the rename/notes edit is visible everywhere immediately. */
export async function fixtureUpdateGuestConfig(
  node: string,
  type: GuestType,
  vmid: number,
  patch: GuestConfigPatch,
): Promise<GuestConfigUpdateResult> {
  setFixtureGuestConfig(node, type, vmid, patch);
  const changed: Array<'name' | 'description'> = [];
  if (patch.name !== undefined) changed.push('name');
  if (patch.description !== undefined) changed.push('description');
  return delay({ ok: true, changed });
}

/** Fixture-mode implementation of `createSnapshot` (see `src/api/actions.ts`): no real request,
 * just a simulated delay and an in-memory add to the fixture snapshot tree (`setFixtureSnapshots`). */
export async function fixtureCreateSnapshot(
  node: string,
  type: GuestType,
  vmid: number,
  body: CreateSnapshotBody,
): Promise<SnapshotActionResult> {
  setFixtureSnapshots(node, type, vmid, {
    op: 'create',
    snapname: body.snapname,
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.vmstate !== undefined ? { vmstate: body.vmstate } : {}),
  });
  return delay({ upid: fakeUpidFor(node, vmid, 'snapshot') });
}

/** Fixture-mode implementation of `deleteSnapshot` (see `src/api/actions.ts`): no real request,
 * just a simulated delay and an in-memory removal from the fixture snapshot tree. `force` has no
 * fixture-visible effect (there's nothing to force through against in-memory data). */
export async function fixtureDeleteSnapshot(
  node: string,
  type: GuestType,
  vmid: number,
  snapname: string,
): Promise<SnapshotActionResult> {
  setFixtureSnapshots(node, type, vmid, { op: 'delete', snapname });
  return delay({ upid: fakeUpidFor(node, vmid, 'delsnapshot') });
}

/** Fixture-mode implementation of `rollbackSnapshot` (see `src/api/actions.ts`): no real
 * request, just a simulated delay, an in-memory move of "current" under the chosen snapshot, and
 * -- when `start` is set -- the same fixture status flip `fixtureGuestAction('start')` gives, so
 * the demo visibly reflects a rollback booting a stopped guest back up. */
export async function fixtureRollbackSnapshot(
  node: string,
  type: GuestType,
  vmid: number,
  snapname: string,
  options?: RollbackSnapshotOptions,
): Promise<SnapshotActionResult> {
  setFixtureSnapshots(node, type, vmid, { op: 'rollback', snapname });
  if (options?.start) {
    setFixtureGuestStatus(node, type, vmid, 'running');
  }
  return delay({ upid: fakeUpidFor(node, vmid, 'rollback') });
}

/** Fixture-mode implementation of `migrateGuest` (see `src/api/actions.ts`): no real request,
 * just a simulated delay and an in-memory move of the guest to `body.target`
 * (`setFixtureGuestNode`), so the demo visibly reflects the migration. The rest of `body`
 * (`online`/`withLocalDisks`/`restart`/`bwlimit`/`targetStorage`) has no fixture-visible effect. */
export async function fixtureMigrateGuest(
  node: string,
  type: GuestType,
  vmid: number,
  body: MigrateGuestBody,
): Promise<GuestActionResult> {
  setFixtureGuestNode(node, type, vmid, body.target);
  return delay({ upid: fakeUpidFor(node, vmid, type === 'qemu' ? 'qmigrate' : 'vzmigrate') });
}

/** Fixture-mode implementation of `getMigratePrecheck` (see `src/api/actions.ts`): a synthetic,
 * demo-friendly precheck computed from the in-memory fixture data (`fixtures.ts`'s
 * `getFixtureMigratePrecheck`), with the same simulated latency every other fixture read uses. */
export async function fixtureMigratePrecheck(
  node: string,
  type: GuestType,
  vmid: number,
  target: string | undefined,
): Promise<MigratePrecheck> {
  return delay(getFixtureMigratePrecheck(node, type, vmid, target));
}

/** Fixture-mode implementation of `nodeAction` (see `src/api/actions.ts`): no real request, just
 * a simulated delay -- a node reboot/shutdown has no fixture-visible state to change (there's no
 * "node is down" concept in the demo's in-memory cluster resources), so `node`/`command` are
 * accepted only to match `nodeAction`'s own signature and otherwise unused. */
export async function fixtureNodeAction(
  node: string,
  command: NodeActionCommand,
): Promise<NodeActionResult> {
  void node;
  void command;
  return delay({ ok: true });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How many progress ticks `fixtureUploadToStorage` reports, and the delay between each --
 * `TICKS * TICK_DELAY_MS` is the ~1.5s total the ticket calls for. */
const UPLOAD_PROGRESS_TICKS = 5;
const UPLOAD_PROGRESS_TICK_MS = 300;

/** Fixture-mode implementation of `uploadToStorage` (see `src/api/actions.ts`): no real request --
 * reports `onProgress` in `UPLOAD_PROGRESS_TICKS` even steps over ~1.5s (so the dialog's progress
 * bar has something to animate), then adds the uploaded file to the in-memory fixture storage
 * content (`addFixtureStorageContent`) under a real-PVE-shaped volid (`<storage>:<content>/<filename>`).
 * `signal` is honoured between ticks, same as a real upload's own cancel button would expect.
 */
export async function fixtureUploadToStorage(
  node: string,
  storage: string,
  options: UploadToStorageOptions,
): Promise<GuestActionResult> {
  const total = options.file.size;
  for (let tick = 1; tick <= UPLOAD_PROGRESS_TICKS; tick += 1) {
    await wait(UPLOAD_PROGRESS_TICK_MS);
    if (options.signal?.aborted) {
      throw new GuestActionError(0, 'Upload cancelled');
    }
    options.onProgress?.(Math.round((total * tick) / UPLOAD_PROGRESS_TICKS), total);
  }

  addFixtureStorageContent(node, storage, {
    volid: `${storage}:${options.content}/${options.filename}`,
    content: options.content,
    size: total,
    ctime: Math.floor(Date.now() / 1000),
  });

  return { upid: fakeUpidFor(node, 0, 'imgcopy') };
}

/** How long `fixtureDownloadUrlToStorage` simulates PVE's own download taking. */
const DOWNLOAD_URL_DELAY_MS = 1000;

/** A plausible fixture size for a downloaded-from-URL volume -- close to a real installer ISO's
 * size, so the demo's storage content browser doesn't show an implausible "0 B" or tiny row. */
const FIXTURE_DOWNLOAD_SIZE_BYTES = 734_003_200;

/** Fixture-mode implementation of `downloadUrlToStorage` (see `src/api/actions.ts`): no real
 * request, just a simulated delay (~1s) and an in-memory add to the fixture storage content, same
 * convention as `fixtureUploadToStorage` above. `checksum`/`checksumAlgorithm`/
 * `verifyCertificates` have no fixture-visible effect. */
export async function fixtureDownloadUrlToStorage(
  node: string,
  storage: string,
  body: DownloadUrlToStorageBody,
): Promise<GuestActionResult> {
  await wait(DOWNLOAD_URL_DELAY_MS);

  addFixtureStorageContent(node, storage, {
    volid: `${storage}:${body.content}/${body.filename}`,
    content: body.content,
    size: FIXTURE_DOWNLOAD_SIZE_BYTES,
    ctime: Math.floor(Date.now() / 1000),
  });

  return { upid: fakeUpidFor(node, 0, 'download') };
}

/** Fixture-mode implementation of `queryUrlMetadata` (see `src/api/actions.ts`): no real request --
 * derives a filename from the URL's own path (falling back to `undefined`, same as PVE itself
 * would report for a URL with no useful path) and reports the same plausible size
 * `fixtureDownloadUrlToStorage` adds, so "Query URL" and the eventual download agree. */
export async function fixtureQueryUrlMetadata(
  node: string,
  url: string,
  verifyCertificates: boolean,
): Promise<UrlMetadataResult> {
  void node;
  void verifyCertificates;
  let filename: string | undefined;
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    filename = segments[segments.length - 1];
  } catch {
    filename = undefined;
  }
  return delay({
    ...(filename !== undefined ? { filename } : {}),
    size: FIXTURE_DOWNLOAD_SIZE_BYTES,
    mimetype: 'application/octet-stream',
  });
}

/** Fixture-mode implementation of `deleteStorageContent` (see `src/api/actions.ts`): no real
 * request, just a simulated delay and an in-memory removal from the fixture storage content
 * (`removeFixtureStorageContent`). `vmid` has no fixture-visible effect (there's no privilege model
 * to satisfy in fixture mode). */
export async function fixtureDeleteStorageContent(
  node: string,
  storage: string,
  volid: string,
): Promise<GuestActionResult> {
  removeFixtureStorageContent(node, storage, volid);
  return delay({ upid: fakeUpidFor(node, 0, 'imgdel') });
}
