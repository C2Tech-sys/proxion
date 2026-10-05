import { USE_FIXTURES } from '@/api/client';
import { GuestActionError } from '@/api/actions';
import { getFixtureGuestByVmid, getFixtureGuestConfig, patchFixtureGuestConfig } from '@/api/fixtures';
import type { GuestType } from '@/api/types';

/**
 * Guest Options (T53): the web side of `PATCH /api/actions/guest/:node/:type/:vmid/options`
 * (`apps/server/src/actions/optionsRoutes.ts`). The Name/Hostname row is NOT part of this -- it
 * reuses the existing rename action (`updateGuestConfig`, `RenameGuestDialog`). Fixture mode is
 * handled inline (same convention as `network.ts`).
 */

/** `order`/`up`/`down` of a `startup` value; every part optional (at least one). */
export interface StartupBody {
  order?: number;
  up?: number;
  down?: number;
}

/** The qemu guest agent option. */
export interface AgentBody {
  enabled: boolean;
  fstrimClonedDisks?: boolean;
}

/** Body for `updateGuestOptions`: every key optional, at least one required -- matches the server
 * route's own contract. qemu-only and lxc-only keys are rejected for the wrong guest type. `null`
 * clears `startup` / `localtime` / `searchdomain`; an empty `tags` / `nameserver` clears those. */
export interface OptionsPatch {
  onboot?: boolean;
  startup?: StartupBody | null;
  protection?: boolean;
  tags?: string[];
  // qemu only
  ostype?: string;
  agent?: AgentBody;
  localtime?: boolean | null;
  tablet?: boolean;
  acpi?: boolean;
  kvm?: boolean;
  hotplug?: string[];
  // lxc only
  nameserver?: string[];
  searchdomain?: string | null;
}

export interface OptionsUpdateResult {
  ok: true;
  /** The PVE config keys the request touched. */
  changed: string[];
  /** The subset of `changed` PVE holds back until the guest restarts. */
  pending: string[];
}

interface OptionsErrorBody {
  error?: string;
  message?: string;
  missing?: string;
}

function describeError(status: number, statusText: string, body: OptionsErrorBody | undefined): string {
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

async function throwActionError(res: Response): Promise<never> {
  let errorBody: OptionsErrorBody | undefined;
  try {
    errorBody = (await res.json()) as OptionsErrorBody;
  } catch {
    errorBody = undefined;
  }
  throw new GuestActionError(res.status, describeError(res.status, res.statusText, errorBody));
}

// --- fixture (demo) mode ----------------------------------------------------------------------

const flag = (value: boolean): number => (value ? 1 : 0);

/** The agent sub-options (`type`, `freeze-fs-on-backup`, ...) an agent edit keeps, like the server. */
function keptAgentOptions(current: string | number | undefined): string[] {
  if (current === undefined) return [];
  return String(current)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => {
      if (part === '' || part === '0' || part === '1') return false;
      const key = part.split('=')[0]!;
      return key !== 'enabled' && key !== 'fstrim_cloned_disks';
    });
}

/**
 * Composes the PVE config values for a patch exactly as the server route does (`1`/`0` booleans,
 * `startup` as `order=..,up=..,down=..`, `;`-joined tags, space-joined nameservers, `hotplug` `0`
 * for none), returning what to set and which keys to clear. Fixture mode applies it to the
 * in-memory config, so the tab re-reads it through the same parser a real config goes through.
 */
export function composeOptions(
  patch: OptionsPatch,
  currentAgent?: string | number,
): { put: Record<string, string | number>; del: string[] } {
  const put: Record<string, string | number> = {};
  const del: string[] = [];
  if (patch.onboot !== undefined) put.onboot = flag(patch.onboot);
  if (patch.startup === null) del.push('startup');
  else if (patch.startup !== undefined) {
    const { order, up, down } = patch.startup;
    put.startup = [
      order !== undefined ? `order=${order}` : '',
      up !== undefined ? `up=${up}` : '',
      down !== undefined ? `down=${down}` : '',
    ]
      .filter(Boolean)
      .join(',');
  }
  if (patch.ostype !== undefined) put.ostype = patch.ostype;
  if (patch.protection !== undefined) put.protection = flag(patch.protection);
  if (patch.tags !== undefined) {
    if (patch.tags.length === 0) del.push('tags');
    else put.tags = patch.tags.join(';');
  }
  if (patch.agent !== undefined) {
    const parts = [`enabled=${flag(patch.agent.enabled)}`];
    if (patch.agent.fstrimClonedDisks === true) parts.push('fstrim_cloned_disks=1');
    parts.push(...keptAgentOptions(currentAgent));
    put.agent = parts.join(',');
  }
  if (patch.localtime === null) del.push('localtime');
  else if (patch.localtime !== undefined) put.localtime = flag(patch.localtime);
  if (patch.tablet !== undefined) put.tablet = flag(patch.tablet);
  if (patch.acpi !== undefined) put.acpi = flag(patch.acpi);
  if (patch.kvm !== undefined) put.kvm = flag(patch.kvm);
  if (patch.hotplug !== undefined) put.hotplug = patch.hotplug.length === 0 ? '0' : patch.hotplug.join(',');
  if (patch.nameserver !== undefined) {
    if (patch.nameserver.length === 0) del.push('nameserver');
    else put.nameserver = patch.nameserver.join(' ');
  }
  if (patch.searchdomain === null) del.push('searchdomain');
  else if (patch.searchdomain !== undefined) put.searchdomain = patch.searchdomain;
  return { put, del };
}

/** The keys a running guest holds back until its next restart (the rest apply immediately). */
const RESTART_KEYS: Record<GuestType, ReadonlySet<string>> = {
  qemu: new Set(['ostype', 'agent', 'localtime', 'tablet', 'acpi', 'kvm', 'hotplug']),
  lxc: new Set(['nameserver', 'searchdomain']),
};

function fixtureUpdateOptions(
  node: string,
  type: GuestType,
  vmid: number,
  patch: OptionsPatch,
): OptionsUpdateResult {
  const current = getFixtureGuestConfig(vmid)?.agent;
  const { put, del } = composeOptions(patch, current);
  const changes: Record<string, string | number | undefined> = { ...put };
  for (const key of del) changes[key] = undefined;
  patchFixtureGuestConfig(node, type, vmid, changes);
  const changed = [...Object.keys(put), ...del];
  const running = getFixtureGuestByVmid(vmid)?.status === 'running';
  return {
    ok: true,
    changed,
    pending: running ? changed.filter((key) => RESTART_KEYS[type].has(key)) : [],
  };
}

// --- public API -------------------------------------------------------------------------------

/**
 * Requests one guest options update. Real mode: `PATCH /api/actions/guest/:node/:type/:vmid/
 * options`. Fixture mode: writes the composed values into the in-memory fixture config.
 */
export async function updateGuestOptions(
  node: string,
  type: GuestType,
  vmid: number,
  patch: OptionsPatch,
): Promise<OptionsUpdateResult> {
  if (USE_FIXTURES) {
    return fixtureUpdateOptions(node, type, vmid, patch);
  }

  const res = await fetch(`/api/actions/guest/${node}/${type}/${vmid}/options`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (res.status === 200) {
    return (await res.json()) as OptionsUpdateResult;
  }
  return throwActionError(res);
}
