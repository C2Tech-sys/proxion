import { USE_FIXTURES } from '@/api/client';
import { GuestActionError } from '@/api/actions';
import {
  addFixtureClusterAlias,
  addFixtureGuestAlias,
  addFixtureGuestIpsetEntry,
  addFixtureClusterIpsetEntry,
  addFixtureClusterRule,
  deleteFixtureClusterAlias,
  deleteFixtureClusterGroup,
  deleteFixtureClusterIpset,
  deleteFixtureClusterIpsetEntry,
  deleteFixtureClusterRule,
  deleteFixtureGuestAlias,
  deleteFixtureGuestIpset,
  deleteFixtureGuestIpsetEntry,
  getFixtureClusterFirewall,
  getFixtureGuestRefs,
  patchFixtureClusterOptions,
  updateFixtureClusterAlias,
  updateFixtureClusterIpsetEntry,
  updateFixtureClusterRule,
  updateFixtureGuestAlias,
  updateFixtureGuestIpsetEntry,
  upsertFixtureClusterGroup,
  upsertFixtureClusterIpset,
  upsertFixtureGuestIpset,
  type FixtureClusterRuleScope,
} from '@/api/fixtures';
import {
  FIREWALL_VERDICTS,
  type FirewallRule,
  type FirewallRuleBody,
  type FirewallRulePatch,
  type FirewallVerdict,
} from '@/api/firewall';
import type { GuestType } from '@/api/types';

/**
 * Datacenter firewall (T67): the web side of `/api/actions/datacenter/firewall/*`
 * (`apps/server/src/actions/clusterFirewallRoutes.ts`) plus the read-only lookups the Datacenter ->
 * Firewall tab needs through the `/api/pve/cluster/firewall/*` proxy. Fixture mode is handled
 * inline in each function (same convention as `firewall.ts`). Rules reuse the guest firewall's
 * body/patch types, so the rule dialog can target either.
 */

/** Where a rule lives: a guest's firewall, the datacenter's own rule list, or one security group's. */
export type ClusterRuleScope = FixtureClusterRuleScope;
export type FirewallTarget = { kind: 'guest'; node: string; type: GuestType; vmid: number } | ClusterRuleScope;
export type GuestFirewallTarget = Extract<FirewallTarget, { kind: 'guest' }>;

/** The default target of the alias / IP set functions: the datacenter firewall. */
export const CLUSTER_FIREWALL_TARGET: FirewallTarget = { kind: 'cluster' };

/** The guest an alias / IP set call addresses, or `undefined` for the datacenter (a security group has
 * no aliases or IP sets of its own, so a group scope reads as the datacenter). */
function guestOf(target: FirewallTarget): GuestFirewallTarget | undefined {
  return target.kind === 'guest' ? target : undefined;
}

/** Read-proxy path (below `/api/pve/`) of the firewall the target addresses. */
function readBase(target: FirewallTarget): string {
  const guest = guestOf(target);
  return guest ? `nodes/${encodeURIComponent(guest.node)}/${guest.type}/${guest.vmid}/firewall` : 'cluster/firewall';
}

export interface ClusterLogRatelimit {
  enabled: boolean;
  burst?: number | undefined;
  /** `<n>/<second|minute|hour|day>`. */
  rate?: string | undefined;
}

/** The datacenter firewall options, normalised (booleans are real booleans, unset PVE defaults are
 * filled in: `ebtables` on, the log rate limit on at 5 / 1 per second). */
export interface ClusterFirewallOptions {
  enable: boolean;
  policy_in?: FirewallVerdict | undefined;
  policy_out?: FirewallVerdict | undefined;
  ebtables: boolean;
  logRatelimit: ClusterLogRatelimit;
  digest?: string | undefined;
}

/** `PUT .../firewall/options` body: only what changed. */
export interface ClusterOptionsPatch {
  enable?: boolean;
  policy_in?: FirewallVerdict;
  policy_out?: FirewallVerdict;
  ebtables?: boolean;
  log_ratelimit?: ClusterLogRatelimit;
  digest?: string;
}

export interface ClusterSecurityGroup {
  group: string;
  comment?: string | undefined;
  digest?: string | undefined;
}

export interface ClusterAlias {
  name: string;
  cidr: string;
  comment?: string | undefined;
  digest?: string | undefined;
}

export interface ClusterIpset {
  name: string;
  comment?: string | undefined;
  digest?: string | undefined;
}

export interface ClusterIpsetEntry {
  cidr: string;
  nomatch: boolean;
  comment?: string | undefined;
  digest?: string | undefined;
}

/** One alias / IP set the rule dialog's source and destination pickers can offer. */
export interface ClusterRef {
  /** What goes in a rule's source / dest: `dc/office`, `+dc/trusted`. */
  ref: string;
  name: string;
  type: 'alias' | 'ipset';
  scope: string;
  comment?: string | undefined;
}

interface ErrorBody {
  error?: string;
  message?: string;
  missing?: string;
}

function describeError(status: number, statusText: string, body: ErrorBody | undefined): string {
  if (body?.message) return body.message;
  switch (body?.error) {
    case 'writes-disabled-in-token-mode':
      return 'Read-only: signed in with a service token';
    case 'forbidden':
      return body?.missing ? `You don't have ${body.missing} on the datacenter` : "You don't have permission for this";
    case 'pve-unreachable':
      return 'Proxmox VE is unreachable';
    default:
      return body?.error ?? `Request failed: ${status} ${statusText}`;
  }
}

async function throwActionError(res: Response): Promise<never> {
  let errorBody: ErrorBody | undefined;
  try {
    errorBody = (await res.json()) as ErrorBody;
  } catch {
    errorBody = undefined;
  }
  throw new GuestActionError(res.status, describeError(res.status, res.statusText, errorBody));
}

const STALE_DIGEST_MESSAGE = 'The firewall configuration changed since it was loaded. Reload and try again.';

function checkFixtureDigest(digest: string | undefined, target: FirewallTarget = CLUSTER_FIREWALL_TARGET): void {
  const guest = guestOf(target);
  const current = guest ? getFixtureGuestRefs(guest.vmid).digest : getFixtureClusterFirewall().digest;
  if (digest !== undefined && digest !== current) {
    throw new GuestActionError(400, STALE_DIGEST_MESSAGE);
  }
}

/** A fixture mutator reports a conflict as a message; turn it into the error the dialogs show. */
function failOn(message: string | undefined): void {
  if (message !== undefined) throw new GuestActionError(400, message);
}

// --- reads ------------------------------------------------------------------------------------

async function readProxy(path: string): Promise<unknown> {
  const res = await fetch(`/api/pve/${path}`);
  if (!res.ok) throw new GuestActionError(res.status, `Failed to load ${path}: ${res.status}`);
  const envelope = (await res.json()) as { data?: unknown };
  return envelope.data;
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  return value === 1 || value === true || value === '1';
}

function asRows(data: unknown): Array<Record<string, unknown>> {
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export const RATE_UNITS = ['second', 'minute', 'hour', 'day'] as const;
export type RateUnit = (typeof RATE_UNITS)[number];

/** PVE's `log_ratelimit` property string (`enable=1,burst=5,rate=1/second`); unset means the default. */
export function parseLogRatelimit(raw: unknown): ClusterLogRatelimit {
  if (typeof raw !== 'string' || raw === '') return { enabled: true, burst: 5, rate: '1/second' };
  const out: ClusterLogRatelimit = { enabled: true };
  for (const part of raw.split(',')) {
    const [key, value] = part.includes('=') ? (part.split('=', 2) as [string, string]) : (['enable', part] as const);
    if (key === 'enable') out.enabled = value === '1';
    else if (key === 'burst' && /^\d+$/.test(value)) out.burst = Number(value);
    else if (key === 'rate' && value !== '') out.rate = value;
  }
  return out;
}

export function normalizeClusterOptions(raw: unknown): ClusterFirewallOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const verdict = (value: unknown): FirewallVerdict | undefined =>
    typeof value === 'string' && (FIREWALL_VERDICTS as readonly string[]).includes(value)
      ? (value as FirewallVerdict)
      : undefined;
  return {
    enable: toBool(o.enable, false),
    policy_in: verdict(o.policy_in),
    policy_out: verdict(o.policy_out),
    ebtables: toBool(o.ebtables, true),
    logRatelimit: parseLogRatelimit(o.log_ratelimit),
    digest: typeof o.digest === 'string' ? o.digest : undefined,
  };
}

/** The datacenter's own rules in evaluation order: `GET /cluster/firewall/rules`. */
export async function getClusterRules(): Promise<FirewallRule[]> {
  if (USE_FIXTURES) {
    const fw = getFixtureClusterFirewall();
    return fw.rules.map((rule) => ({ ...rule, digest: fw.digest }));
  }
  return asRows(await readProxy('cluster/firewall/rules')) as unknown as FirewallRule[];
}

/** One security group's rules: `GET /cluster/firewall/groups/{group}`. */
export async function getGroupRules(group: string): Promise<FirewallRule[]> {
  if (USE_FIXTURES) {
    const fw = getFixtureClusterFirewall();
    const found = fw.groups.find((g) => g.group === group);
    if (!found) throw new GuestActionError(404, `Security group '${group}' does not exist`);
    return found.rules.map((rule) => ({ ...rule, digest: fw.digest }));
  }
  return asRows(await readProxy(`cluster/firewall/groups/${encodeURIComponent(group)}`)) as unknown as FirewallRule[];
}

export async function getClusterOptions(): Promise<ClusterFirewallOptions> {
  if (USE_FIXTURES) {
    const fw = getFixtureClusterFirewall();
    return normalizeClusterOptions({ ...fw.options, digest: fw.digest });
  }
  return normalizeClusterOptions(await readProxy('cluster/firewall/options'));
}

export async function getClusterGroups(): Promise<ClusterSecurityGroup[]> {
  if (USE_FIXTURES) {
    const fw = getFixtureClusterFirewall();
    return fw.groups.map((g) => ({ group: g.group, comment: g.comment, digest: fw.digest }));
  }
  return asRows(await readProxy('cluster/firewall/groups'))
    .filter((row): row is Record<string, unknown> & { group: string } => typeof row.group === 'string')
    .map((row) => ({ group: row.group, comment: str(row.comment), digest: str(row.digest) }))
    .sort((a, b) => a.group.localeCompare(b.group));
}

/** The aliases of the datacenter firewall, or of one guest's when `target` is a guest. */
export async function getClusterAliases(target: FirewallTarget = CLUSTER_FIREWALL_TARGET): Promise<ClusterAlias[]> {
  if (USE_FIXTURES) {
    const guest = guestOf(target);
    const fw = guest ? getFixtureGuestRefs(guest.vmid) : getFixtureClusterFirewall();
    return fw.aliases.map((a) => ({ name: a.name, cidr: a.cidr, comment: a.comment, digest: fw.digest }));
  }
  return asRows(await readProxy(`${readBase(target)}/aliases`))
    .filter((row): row is Record<string, unknown> & { name: string; cidr: string } =>
      typeof row.name === 'string' && typeof row.cidr === 'string')
    .map((row) => ({ name: row.name, cidr: row.cidr, comment: str(row.comment), digest: str(row.digest) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The IP sets of the datacenter firewall, or of one guest's when `target` is a guest. */
export async function getClusterIpsets(target: FirewallTarget = CLUSTER_FIREWALL_TARGET): Promise<ClusterIpset[]> {
  if (USE_FIXTURES) {
    const guest = guestOf(target);
    const fw = guest ? getFixtureGuestRefs(guest.vmid) : getFixtureClusterFirewall();
    return fw.ipsets.map((i) => ({ name: i.name, comment: i.comment, digest: fw.digest }));
  }
  return asRows(await readProxy(`${readBase(target)}/ipset`))
    .filter((row): row is Record<string, unknown> & { name: string } => typeof row.name === 'string')
    .map((row) => ({ name: row.name, comment: str(row.comment), digest: str(row.digest) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getIpsetEntries(
  name: string,
  target: FirewallTarget = CLUSTER_FIREWALL_TARGET,
): Promise<ClusterIpsetEntry[]> {
  if (USE_FIXTURES) {
    const guest = guestOf(target);
    const fw = guest ? getFixtureGuestRefs(guest.vmid) : getFixtureClusterFirewall();
    const found = fw.ipsets.find((i) => i.name === name);
    if (!found) throw new GuestActionError(404, `IPSet '${name}' does not exist`);
    return found.entries.map((e) => ({ cidr: e.cidr, nomatch: e.nomatch === true, comment: e.comment, digest: fw.digest }));
  }
  return asRows(await readProxy(`${readBase(target)}/ipset/${encodeURIComponent(name)}`))
    .filter((row): row is Record<string, unknown> & { cidr: string } => typeof row.cidr === 'string')
    .map((row) => ({
      cidr: row.cidr,
      nomatch: toBool(row.nomatch, false),
      comment: str(row.comment),
      digest: str(row.digest),
    }));
}

/** The aliases and IP sets a rule's source / destination can name (`GET /cluster/firewall/refs`, or a
 * guest's `GET /nodes/{node}/{type}/{vmid}/firewall/refs`, which adds the guest's own ones to the
 * inherited datacenter ones). A 403 is tolerated: the picker just offers nothing. */
export async function getClusterRefs(target: FirewallTarget = CLUSTER_FIREWALL_TARGET): Promise<ClusterRef[]> {
  if (USE_FIXTURES) {
    const fw = getFixtureClusterFirewall();
    const guest = guestOf(target);
    const own = guest ? getFixtureGuestRefs(guest.vmid) : undefined;
    return [
      ...(own?.aliases ?? []).map((a) => ({
        ref: `guest/${a.name}`,
        name: a.name,
        type: 'alias' as const,
        scope: 'guest',
        comment: a.comment,
      })),
      ...(own?.ipsets ?? []).map((i) => ({
        ref: `+guest/${i.name}`,
        name: i.name,
        type: 'ipset' as const,
        scope: 'guest',
        comment: i.comment,
      })),
      ...fw.aliases.map((a) => ({
        ref: `dc/${a.name}`,
        name: a.name,
        type: 'alias' as const,
        scope: 'dc',
        comment: a.comment,
      })),
      ...fw.ipsets.map((i) => ({
        ref: `+dc/${i.name}`,
        name: i.name,
        type: 'ipset' as const,
        scope: 'dc',
        comment: i.comment,
      })),
    ];
  }
  const res = await fetch(`/api/pve/${readBase(target)}/refs`);
  if (res.status === 403) return [];
  if (!res.ok) throw new GuestActionError(res.status, `Failed to load firewall references: ${res.status}`);
  const envelope = (await res.json()) as { data?: unknown };
  return asRows(envelope.data)
    .filter(
      (row): row is Record<string, unknown> & { ref: string; name: string; type: 'alias' | 'ipset' } =>
        typeof row.ref === 'string' && typeof row.name === 'string' && (row.type === 'alias' || row.type === 'ipset'),
    )
    .map((row) => ({
      ref: row.ref,
      name: row.name,
      type: row.type,
      scope: typeof row.scope === 'string' ? row.scope : 'dc',
      comment: str(row.comment),
    }));
}

// --- writes -----------------------------------------------------------------------------------

const BASE = '/api/actions/datacenter/firewall';

/** The allow-listed write route of the firewall the target addresses. */
function writeBase(target: FirewallTarget): string {
  const guest = guestOf(target);
  return guest ? `/api/actions/guest/${encodeURIComponent(guest.node)}/${guest.type}/${guest.vmid}/firewall` : BASE;
}

/** Sends one write; `200`/`201` is success, anything else throws the mapped error. */
async function send(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  target: FirewallTarget = CLUSTER_FIREWALL_TARGET,
): Promise<void> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${writeBase(target)}${path}`, init);
  if (res.status === 200 || res.status === 201) return;
  return throwActionError(res);
}

function rulesPath(scope: ClusterRuleScope): string {
  return scope.kind === 'cluster' ? '/rules' : `/groups/${encodeURIComponent(scope.group)}/rules`;
}

function digestQuery(digest: string | undefined): string {
  return digest !== undefined ? `?digest=${encodeURIComponent(digest)}` : '';
}

function fixtureRuleFields(body: FirewallRuleBody) {
  return {
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
  };
}

/** Adds one rule to the datacenter (or to a security group): `POST .../rules`. */
export async function addClusterRule(scope: ClusterRuleScope, body: FirewallRuleBody): Promise<void> {
  if (USE_FIXTURES) {
    if (!addFixtureClusterRule(scope, fixtureRuleFields(body), body.pos)) {
      throw new GuestActionError(404, 'That security group does not exist');
    }
    return;
  }
  return send('POST', rulesPath(scope), body);
}

/** Edits, toggles or moves one rule: `PUT .../rules/:pos`. */
export async function updateClusterRule(scope: ClusterRuleScope, pos: number, patch: FirewallRulePatch): Promise<void> {
  if (USE_FIXTURES) {
    const { delete: clear, moveto, digest, enable, icmpType, ...rest } = patch;
    checkFixtureDigest(digest);
    const found = updateFixtureClusterRule(
      scope,
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
  return send('PUT', `${rulesPath(scope)}/${pos}`, patch);
}

/** Removes one rule: `DELETE .../rules/:pos[?digest=]`. */
export async function deleteClusterRule(scope: ClusterRuleScope, pos: number, digest?: string): Promise<void> {
  if (USE_FIXTURES) {
    checkFixtureDigest(digest);
    if (!deleteFixtureClusterRule(scope, pos)) {
      throw new GuestActionError(404, `There is no firewall rule at position ${pos}`);
    }
    return;
  }
  return send('DELETE', `${rulesPath(scope)}/${pos}${digestQuery(digest)}`);
}

/** Saves the datacenter firewall options (only the keys given): `PUT .../firewall/options`. */
export async function updateClusterOptions(patch: ClusterOptionsPatch): Promise<void> {
  if (USE_FIXTURES) {
    const { digest, log_ratelimit, ...options } = patch;
    checkFixtureDigest(digest);
    patchFixtureClusterOptions({
      ...options,
      ...(log_ratelimit !== undefined ? { log_ratelimit: composeLogRatelimit(log_ratelimit) } : {}),
    });
    return;
  }
  return send('PUT', '/options', patch);
}

export function composeLogRatelimit(value: ClusterLogRatelimit): string {
  const parts = [`enable=${value.enabled ? 1 : 0}`];
  if (value.burst !== undefined) parts.push(`burst=${value.burst}`);
  if (value.rate !== undefined) parts.push(`rate=${value.rate}`);
  return parts.join(',');
}

export interface SecurityGroupSave {
  /** The group's name (the NEW name when renaming -- PVE's own field semantics). */
  group: string;
  comment?: string | undefined;
  /** The EXISTING group's name when editing it (set equal to `group` to only change the comment). */
  rename?: string | undefined;
  digest?: string | undefined;
}

/** Creates a security group, or edits an existing one when `rename` names it: `POST .../groups`. */
export async function saveSecurityGroup(save: SecurityGroupSave): Promise<void> {
  if (USE_FIXTURES) {
    checkFixtureDigest(save.digest);
    failOn(upsertFixtureClusterGroup(save.group, save.comment, save.rename));
    return;
  }
  const body: Record<string, string> = { group: save.group };
  if (save.comment !== undefined) body.comment = save.comment;
  if (save.rename !== undefined) body.rename = save.rename;
  if (save.digest !== undefined) body.digest = save.digest;
  return send('POST', '/groups', body);
}

/** Removes a security group: `DELETE .../groups/:group`. */
export async function deleteSecurityGroup(group: string): Promise<void> {
  if (USE_FIXTURES) {
    failOn(deleteFixtureClusterGroup(group));
    return;
  }
  return send('DELETE', `/groups/${encodeURIComponent(group)}`);
}

export interface AliasCreate {
  name: string;
  cidr: string;
  comment?: string | undefined;
}

export async function createAlias(alias: AliasCreate, target: FirewallTarget = CLUSTER_FIREWALL_TARGET): Promise<void> {
  if (USE_FIXTURES) {
    const entry = { name: alias.name, cidr: alias.cidr, ...(alias.comment ? { comment: alias.comment } : {}) };
    const guest = guestOf(target);
    failOn(guest ? addFixtureGuestAlias(guest.vmid, entry) : addFixtureClusterAlias(entry));
    return;
  }
  const body: Record<string, string> = { name: alias.name, cidr: alias.cidr };
  if (alias.comment !== undefined) body.comment = alias.comment;
  return send('POST', '/aliases', body, target);
}

export interface AliasUpdate {
  /** The alias's current name (the path). */
  name: string;
  cidr: string;
  comment?: string | undefined;
  /** The new name, only when it changes. */
  rename?: string | undefined;
  digest?: string | undefined;
}

export async function updateAlias(update: AliasUpdate, target: FirewallTarget = CLUSTER_FIREWALL_TARGET): Promise<void> {
  if (USE_FIXTURES) {
    checkFixtureDigest(update.digest, target);
    const next = { cidr: update.cidr, comment: update.comment, rename: update.rename };
    const guest = guestOf(target);
    failOn(guest ? updateFixtureGuestAlias(guest.vmid, update.name, next) : updateFixtureClusterAlias(update.name, next));
    return;
  }
  const body: Record<string, string> = { cidr: update.cidr };
  if (update.comment !== undefined) body.comment = update.comment;
  if (update.rename !== undefined) body.rename = update.rename;
  if (update.digest !== undefined) body.digest = update.digest;
  return send('PUT', `/aliases/${encodeURIComponent(update.name)}`, body, target);
}

export async function deleteAlias(
  name: string,
  digest?: string,
  target: FirewallTarget = CLUSTER_FIREWALL_TARGET,
): Promise<void> {
  if (USE_FIXTURES) {
    checkFixtureDigest(digest, target);
    const guest = guestOf(target);
    failOn(guest ? deleteFixtureGuestAlias(guest.vmid, name) : deleteFixtureClusterAlias(name));
    return;
  }
  return send('DELETE', `/aliases/${encodeURIComponent(name)}${digestQuery(digest)}`, undefined, target);
}

export interface IpsetSave {
  /** The set's name (the NEW name when renaming -- PVE's own field semantics). */
  name: string;
  comment?: string | undefined;
  /** The EXISTING set's name when editing it (equal to `name` to only change the comment). */
  rename?: string | undefined;
  digest?: string | undefined;
}

/** Creates an IP set, or edits an existing one when `rename` names it: `POST .../ipsets`. */
export async function saveIpset(save: IpsetSave, target: FirewallTarget = CLUSTER_FIREWALL_TARGET): Promise<void> {
  if (USE_FIXTURES) {
    checkFixtureDigest(save.digest, target);
    const guest = guestOf(target);
    failOn(
      guest
        ? upsertFixtureGuestIpset(guest.vmid, save.name, save.comment, save.rename)
        : upsertFixtureClusterIpset(save.name, save.comment, save.rename),
    );
    return;
  }
  const body: Record<string, string> = { name: save.name };
  if (save.comment !== undefined) body.comment = save.comment;
  if (save.rename !== undefined) body.rename = save.rename;
  if (save.digest !== undefined) body.digest = save.digest;
  return send('POST', '/ipsets', body, target);
}

/** Removes an IP set (`force` also drops its entries): `DELETE .../ipsets/:name[?force=1]`. */
export async function deleteIpset(
  name: string,
  force: boolean,
  target: FirewallTarget = CLUSTER_FIREWALL_TARGET,
): Promise<void> {
  if (USE_FIXTURES) {
    const guest = guestOf(target);
    failOn(guest ? deleteFixtureGuestIpset(guest.vmid, name, force) : deleteFixtureClusterIpset(name, force));
    return;
  }
  return send('DELETE', `/ipsets/${encodeURIComponent(name)}${force ? '?force=1' : ''}`, undefined, target);
}

export interface IpsetEntryCreate {
  name: string;
  cidr: string;
  nomatch?: boolean | undefined;
  comment?: string | undefined;
}

export async function addIpsetEntry(entry: IpsetEntryCreate, target: FirewallTarget = CLUSTER_FIREWALL_TARGET): Promise<void> {
  if (USE_FIXTURES) {
    const row = {
      cidr: entry.cidr,
      ...(entry.nomatch ? { nomatch: true } : {}),
      ...(entry.comment ? { comment: entry.comment } : {}),
    };
    const guest = guestOf(target);
    failOn(guest ? addFixtureGuestIpsetEntry(guest.vmid, entry.name, row) : addFixtureClusterIpsetEntry(entry.name, row));
    return;
  }
  const body: Record<string, string | boolean> = { cidr: entry.cidr };
  if (entry.nomatch !== undefined) body.nomatch = entry.nomatch;
  if (entry.comment !== undefined) body.comment = entry.comment;
  return send('POST', `/ipsets/${encodeURIComponent(entry.name)}`, body, target);
}

export interface IpsetEntryUpdate {
  name: string;
  cidr: string;
  nomatch?: boolean | undefined;
  comment?: string | undefined;
  digest?: string | undefined;
}

export async function updateIpsetEntry(
  update: IpsetEntryUpdate,
  target: FirewallTarget = CLUSTER_FIREWALL_TARGET,
): Promise<void> {
  if (USE_FIXTURES) {
    checkFixtureDigest(update.digest, target);
    const next = { nomatch: update.nomatch, comment: update.comment };
    const guest = guestOf(target);
    failOn(
      guest
        ? updateFixtureGuestIpsetEntry(guest.vmid, update.name, update.cidr, next)
        : updateFixtureClusterIpsetEntry(update.name, update.cidr, next),
    );
    return;
  }
  const body: Record<string, string | boolean> = {};
  if (update.nomatch !== undefined) body.nomatch = update.nomatch;
  if (update.comment !== undefined) body.comment = update.comment;
  if (update.digest !== undefined) body.digest = update.digest;
  return send('PUT', `/ipsets/${encodeURIComponent(update.name)}/${encodeURIComponent(update.cidr)}`, body, target);
}

export async function deleteIpsetEntry(
  name: string,
  cidr: string,
  digest?: string,
  target: FirewallTarget = CLUSTER_FIREWALL_TARGET,
): Promise<void> {
  if (USE_FIXTURES) {
    checkFixtureDigest(digest, target);
    const guest = guestOf(target);
    failOn(guest ? deleteFixtureGuestIpsetEntry(guest.vmid, name, cidr) : deleteFixtureClusterIpsetEntry(name, cidr));
    return;
  }
  return send(
    'DELETE',
    `/ipsets/${encodeURIComponent(name)}/${encodeURIComponent(cidr)}${digestQuery(digest)}`,
    undefined,
    target,
  );
}
