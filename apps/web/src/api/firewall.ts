import { USE_FIXTURES } from '@/api/client';
import { GuestActionError } from '@/api/actions';
import {
  addFixtureFirewallRule,
  deleteFixtureFirewallRule,
  FIXTURE_FIREWALL_MACROS,
  FIXTURE_SECURITY_GROUPS,
  getFixtureFirewall,
  patchFixtureFirewallOptions,
  updateFixtureFirewallRule,
} from '@/api/fixtures';
import type { GuestType } from '@/api/types';

/**
 * Guest firewall (T56): the web side of `POST/PUT/DELETE .../firewall/rules[/:pos]` and
 * `PUT .../firewall/options` (`apps/server/src/actions/firewallRoutes.ts`), plus the read-only
 * lookups the Firewall tab needs (the rule list, the options, the cluster's security groups and
 * macros) through the read-only `/api/pve/*` proxy. Fixture mode is handled inline in each
 * function (same convention as `network.ts`).
 */

export type FirewallRuleType = 'in' | 'out' | 'group';
export type FirewallVerdict = 'ACCEPT' | 'DROP' | 'REJECT';

export const FIREWALL_VERDICTS: readonly FirewallVerdict[] = ['ACCEPT', 'DROP', 'REJECT'];
export const FIREWALL_LOG_LEVELS = [
  'emerg',
  'alert',
  'crit',
  'err',
  'warning',
  'notice',
  'info',
  'debug',
  'nolog',
] as const;
export type FirewallLogLevel = (typeof FIREWALL_LOG_LEVELS)[number];

/** One rule as PVE's `GET .../firewall/rules` returns it (the fields the tab shows). */
export interface FirewallRule {
  pos: number;
  /** `in`, `out` or `group` (PVE also has `forward`, which a guest never lists). */
  type: string;
  /** A verdict for `in`/`out`, a security-group name for `group`. */
  action: string;
  /** PVE sends 0/1. */
  enable?: number | undefined;
  macro?: string | undefined;
  proto?: string | undefined;
  source?: string | undefined;
  dest?: string | undefined;
  sport?: string | undefined;
  dport?: string | undefined;
  iface?: string | undefined;
  log?: string | undefined;
  comment?: string | undefined;
  'icmp-type'?: string | undefined;
  /** The firewall config's digest at the time of the read, for optimistic concurrency. */
  digest?: string | undefined;
}

/** The guest's firewall options, normalised: booleans are real booleans, unset PVE defaults are
 * filled in (`macfilter` and `ndp` default on; the rest off); the policies and log levels stay
 * `undefined` when unset (the datacenter default applies). */
export interface FirewallOptions {
  enable: boolean;
  dhcp: boolean;
  ndp: boolean;
  radv: boolean;
  macfilter: boolean;
  ipfilter: boolean;
  policy_in?: FirewallVerdict | undefined;
  policy_out?: FirewallVerdict | undefined;
  log_level_in?: FirewallLogLevel | undefined;
  log_level_out?: FirewallLogLevel | undefined;
  digest?: string | undefined;
}

/** The wire shape of the options (`PUT` body keys, minus the digest). */
export interface FirewallOptionsPatch {
  enable?: boolean;
  dhcp?: boolean;
  ndp?: boolean;
  radv?: boolean;
  macfilter?: boolean;
  ipfilter?: boolean;
  policy_in?: FirewallVerdict;
  policy_out?: FirewallVerdict;
  log_level_in?: FirewallLogLevel;
  log_level_out?: FirewallLogLevel;
  digest?: string;
}

/** `POST .../firewall/rules` body. Matches the server route's own contract. */
export interface FirewallRuleBody {
  type: FirewallRuleType;
  action: string;
  enable?: boolean;
  macro?: string;
  proto?: string;
  source?: string;
  dest?: string;
  sport?: string;
  dport?: string;
  iface?: string;
  log?: FirewallLogLevel;
  comment?: string;
  icmpType?: string;
  pos?: number;
}

/** The string fields a PUT can clear through its `delete` list. */
export type ClearableRuleField =
  | 'macro'
  | 'proto'
  | 'source'
  | 'dest'
  | 'sport'
  | 'dport'
  | 'iface'
  | 'log'
  | 'comment'
  | 'icmpType';

/** `PUT .../firewall/rules/:pos` body: only what changed. */
export interface FirewallRulePatch {
  type?: FirewallRuleType;
  action?: string;
  enable?: boolean;
  macro?: string;
  proto?: string;
  source?: string;
  dest?: string;
  sport?: string;
  dport?: string;
  iface?: string;
  log?: FirewallLogLevel;
  comment?: string;
  icmpType?: string;
  moveto?: number;
  delete?: ClearableRuleField[];
  digest?: string;
}

export interface SecurityGroup {
  group: string;
  comment?: string | undefined;
}

export interface FirewallMacro {
  macro: string;
  descr?: string | undefined;
}

interface FirewallErrorBody {
  error?: string;
  message?: string;
  missing?: string;
}

/** Same short, human-readable mapping `network.ts` uses (its own copy is module-private). */
function describeError(status: number, statusText: string, body: FirewallErrorBody | undefined): string {
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
  let errorBody: FirewallErrorBody | undefined;
  try {
    errorBody = (await res.json()) as FirewallErrorBody;
  } catch {
    errorBody = undefined;
  }
  throw new GuestActionError(res.status, describeError(res.status, res.statusText, errorBody));
}

const STALE_DIGEST_MESSAGE = 'The firewall configuration changed since it was loaded. Reload and try again.';

function checkFixtureDigest(vmid: number, digest: string | undefined): void {
  if (digest !== undefined && digest !== getFixtureFirewall(vmid).digest) {
    throw new GuestActionError(400, STALE_DIGEST_MESSAGE);
  }
}

// --- reads ------------------------------------------------------------------------------------

async function readProxy(path: string): Promise<unknown> {
  const res = await fetch(`/api/pve/${path}`);
  if (!res.ok) throw new GuestActionError(res.status, `Failed to load ${path}: ${res.status}`);
  const envelope = (await res.json()) as { data?: unknown };
  return envelope.data;
}

/** PVE reports booleans as 0/1 (sometimes `true`/`false` or `"1"`). */
function toBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  return value === 1 || value === true || value === '1';
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

export function normalizeFirewallOptions(raw: unknown): FirewallOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    enable: toBool(o.enable, false),
    dhcp: toBool(o.dhcp, false),
    ndp: toBool(o.ndp, true),
    radv: toBool(o.radv, false),
    macfilter: toBool(o.macfilter, true),
    ipfilter: toBool(o.ipfilter, false),
    policy_in: pickEnum(o.policy_in, FIREWALL_VERDICTS),
    policy_out: pickEnum(o.policy_out, FIREWALL_VERDICTS),
    log_level_in: pickEnum(o.log_level_in, FIREWALL_LOG_LEVELS),
    log_level_out: pickEnum(o.log_level_out, FIREWALL_LOG_LEVELS),
    digest: typeof o.digest === 'string' ? o.digest : undefined,
  };
}

/** The guest's firewall rules in evaluation order: `GET /nodes/{node}/{type}/{vmid}/firewall/rules`. */
export async function getFirewallRules(node: string, type: GuestType, vmid: number): Promise<FirewallRule[]> {
  if (USE_FIXTURES) {
    return getFixtureFirewall(vmid).rules.map((rule) => ({ ...rule, digest: getFixtureFirewall(vmid).digest }));
  }
  const data = await readProxy(`nodes/${node}/${type}/${vmid}/firewall/rules`);
  return Array.isArray(data) ? (data as FirewallRule[]) : [];
}

/** The guest's firewall options: `GET /nodes/{node}/{type}/{vmid}/firewall/options`. */
export async function getFirewallOptions(node: string, type: GuestType, vmid: number): Promise<FirewallOptions> {
  if (USE_FIXTURES) {
    const fixture = getFixtureFirewall(vmid);
    return normalizeFirewallOptions({ ...fixture.options, digest: fixture.digest });
  }
  return normalizeFirewallOptions(await readProxy(`nodes/${node}/${type}/${vmid}/firewall/options`));
}

/** The cluster's security groups (for the group-rule picker). A caller without `Sys.Audit` /
 * firewall access on the datacenter gets a 403 from PVE; that is not an error here -- the picker
 * just falls back to a free-text field. */
export async function getSecurityGroups(): Promise<SecurityGroup[]> {
  if (USE_FIXTURES) return FIXTURE_SECURITY_GROUPS;
  const res = await fetch('/api/pve/cluster/firewall/groups');
  if (res.status === 403) return [];
  if (!res.ok) throw new GuestActionError(res.status, `Failed to load security groups: ${res.status}`);
  const envelope = (await res.json()) as { data?: unknown };
  if (!Array.isArray(envelope.data)) return [];
  return (envelope.data as Array<{ group?: unknown; comment?: unknown }>)
    .filter((g): g is { group: string; comment?: unknown } => typeof g.group === 'string')
    .map((g) => ({ group: g.group, ...(typeof g.comment === 'string' && g.comment !== '' ? { comment: g.comment } : {}) }))
    .sort((a, b) => a.group.localeCompare(b.group));
}

/** PVE's firewall macros (for the macro picker). A 403 is tolerated like `getSecurityGroups`. */
export async function getMacros(): Promise<FirewallMacro[]> {
  if (USE_FIXTURES) return FIXTURE_FIREWALL_MACROS;
  const res = await fetch('/api/pve/cluster/firewall/macros');
  if (res.status === 403) return [];
  if (!res.ok) throw new GuestActionError(res.status, `Failed to load firewall macros: ${res.status}`);
  const envelope = (await res.json()) as { data?: unknown };
  if (!Array.isArray(envelope.data)) return [];
  return (envelope.data as Array<{ macro?: unknown; descr?: unknown }>)
    .filter((m): m is { macro: string; descr?: unknown } => typeof m.macro === 'string')
    .map((m) => ({ macro: m.macro, ...(typeof m.descr === 'string' && m.descr !== '' ? { descr: m.descr } : {}) }))
    .sort((a, b) => a.macro.localeCompare(b.macro));
}

// --- writes -----------------------------------------------------------------------------------

function baseUrl(node: string, type: GuestType, vmid: number): string {
  return `/api/actions/guest/${node}/${type}/${vmid}/firewall`;
}

/** Adds one rule: `POST .../firewall/rules`. */
export async function addFirewallRule(node: string, type: GuestType, vmid: number, body: FirewallRuleBody): Promise<void> {
  if (USE_FIXTURES) {
    addFixtureFirewallRule(vmid, {
      type: body.type,
      action: body.action,
      enable: body.enable === false ? 0 : 1,
      macro: body.macro,
      proto: body.proto,
      source: body.source,
      dest: body.dest,
      sport: body.sport,
      dport: body.dport,
      iface: body.iface,
      log: body.log,
      comment: body.comment,
      'icmp-type': body.icmpType,
    }, body.pos);
    return;
  }

  const res = await fetch(`${baseUrl(node, type, vmid)}/rules`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 201 || res.status === 200) return;
  return throwActionError(res);
}

/** Edits one rule (only the fields that changed), toggles it, or moves it: `PUT .../rules/:pos`. */
export async function updateFirewallRule(
  node: string,
  type: GuestType,
  vmid: number,
  pos: number,
  patch: FirewallRulePatch,
): Promise<void> {
  if (USE_FIXTURES) {
    const { delete: clear, moveto, digest, enable, icmpType, ...rest } = patch;
    checkFixtureDigest(vmid, digest);
    const found = updateFixtureFirewallRule(
      vmid,
      pos,
      {
        ...rest,
        ...(enable !== undefined ? { enable: enable ? 1 : 0 } : {}),
        ...(icmpType !== undefined ? { 'icmp-type': icmpType } : {}),
      },
      (clear ?? []).map((field) => (field === 'icmpType' ? 'icmp-type' : field)),
      moveto,
    );
    if (!found) throw new GuestActionError(404, `There is no firewall rule at position ${pos}`);
    return;
  }

  const res = await fetch(`${baseUrl(node, type, vmid)}/rules/${pos}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (res.status === 200) return;
  return throwActionError(res);
}

/** Removes one rule: `DELETE .../rules/:pos[?digest=]`. */
export async function deleteFirewallRule(
  node: string,
  type: GuestType,
  vmid: number,
  pos: number,
  digest?: string,
): Promise<void> {
  if (USE_FIXTURES) {
    checkFixtureDigest(vmid, digest);
    if (!deleteFixtureFirewallRule(vmid, pos)) {
      throw new GuestActionError(404, `There is no firewall rule at position ${pos}`);
    }
    return;
  }

  const query = digest !== undefined ? `?digest=${encodeURIComponent(digest)}` : '';
  const res = await fetch(`${baseUrl(node, type, vmid)}/rules/${pos}${query}`, { method: 'DELETE' });
  if (res.status === 200) return;
  return throwActionError(res);
}

/** Saves firewall options (only the keys given): `PUT .../firewall/options`. */
export async function updateFirewallOptions(
  node: string,
  type: GuestType,
  vmid: number,
  patch: FirewallOptionsPatch,
): Promise<void> {
  if (USE_FIXTURES) {
    const { digest, ...options } = patch;
    checkFixtureDigest(vmid, digest);
    patchFixtureFirewallOptions(vmid, options);
    return;
  }

  const res = await fetch(`${baseUrl(node, type, vmid)}/options`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (res.status === 200) return;
  return throwActionError(res);
}
