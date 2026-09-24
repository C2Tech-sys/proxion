import { setFixtureGuestConfig, setFixtureGuestStatus } from '@/api/fixtures';
import type { GuestType } from '@/api/types';
import type { GuestAction, GuestActionResult, GuestConfigPatch, GuestConfigUpdateResult } from '@/api/actions';

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
  fixtureUpidSeq += 1;
  const seq = fixtureUpidSeq.toString(16).padStart(8, '0');
  return `UPID:${node}:${seq}:00000000:00000000:${action}:${vmid}:demo@pve!fixtures:`;
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
