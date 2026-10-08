import { USE_FIXTURES } from '@/api/client';
import { GuestActionError } from '@/api/actions';
import {
  getFixtureNodeCertificates,
  getFixtureNodeConfig,
  getFixtureNodeDns,
  getFixtureNodeHosts,
  getFixtureNodeTime,
  removeFixtureNodeCertificate,
  saveFixtureNodeHosts,
  updateFixtureNodeDns,
  updateFixtureNodeOptions,
  updateFixtureNodeTime,
  uploadFixtureNodeCertificate,
} from '@/api/fixtures';

/**
 * Node System tab (T71): the web side of `PUT /api/actions/node/:node/system/{dns,time,options}`,
 * `POST .../system/hosts` and `POST|DELETE .../system/certificates`
 * (`apps/server/src/actions/nodeSystemRoutes.ts`), plus the reads of `GET /nodes/{node}/{dns,time,
 * config,hosts,certificates/info}` through the read-only `/api/pve/*` proxy (which forwards PVE's
 * `{ data }` envelope). Fixture mode is handled inline in each function (same convention as
 * `nodeNetwork.ts`).
 */

export interface NodeDns {
  search: string;
  dns1?: string;
  dns2?: string;
  dns3?: string;
}

export interface NodeTime {
  timezone: string;
  /** Epoch seconds (UTC). */
  time: number;
  /** PVE's "local time" epoch: the server's wall clock, expressed as if it were UTC. */
  localtime: number;
}

export interface NodeOptions {
  description?: string;
  startallOnbootDelay?: number;
  wakeonlan?: string;
  ballooningTarget?: number;
  digest?: string;
}

export interface NodeHosts {
  data: string;
  digest?: string;
}

export interface NodeCertificate {
  filename: string;
  fingerprint?: string;
  subject?: string;
  issuer?: string;
  san: string[];
  /** Epoch seconds. */
  notbefore?: number;
  notafter?: number;
  publicKeyType?: string;
  publicKeyBits?: number;
}

/** `PUT .../system/dns`: every server is always sent; an empty one is `null` (left out of PVE's
 * rewrite of resolv.conf). */
export interface UpdateDnsBody {
  search: string;
  dns1: string | null;
  dns2: string | null;
  dns3: string | null;
}

export interface UpdateTimeBody {
  timezone: string;
}

/** `PUT .../system/options`: only what changed; an explicit `null` clears the option. */
export interface UpdateOptionsBody {
  description?: string | null;
  startallOnbootDelay?: number | null;
  wakeonlan?: string | null;
  ballooningTarget?: number | null;
  digest?: string;
}

export interface SaveHostsBody {
  data: string;
  digest?: string;
}

/** `POST .../system/certificates`. `key` is a secret: it is sent once and never kept. */
export interface UploadCertificateBody {
  certificates: string;
  key?: string;
  force?: boolean;
  restart: boolean;
}

export interface RemoveCertificateBody {
  restart: boolean;
}

interface NodeSystemErrorBody {
  error?: string;
  message?: string;
  missing?: string;
}

function describeError(status: number, statusText: string, body: NodeSystemErrorBody | undefined): string {
  if (body?.message) return body.message;
  switch (body?.error) {
    case 'writes-disabled-in-token-mode':
      return 'Read-only: signed in with a service token';
    case 'forbidden':
      return body?.missing ? `You don't have ${body.missing} on this node` : "You don't have permission for this";
    case 'pve-unreachable':
      return 'Proxmox VE is unreachable';
    default:
      return body?.error ?? `Request failed: ${status} ${statusText}`;
  }
}

async function throwActionError(res: Response): Promise<never> {
  let errorBody: NodeSystemErrorBody | undefined;
  try {
    errorBody = (await res.json()) as NodeSystemErrorBody;
  } catch {
    errorBody = undefined;
  }
  throw new GuestActionError(res.status, describeError(res.status, res.statusText, errorBody));
}

/** Runs a fixture mutator, turning its plain `Error` into the same error the real client throws. */
function fixtureCall<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new GuestActionError(400, error instanceof Error ? error.message : 'The change was rejected');
  }
}

// --- parsing -----------------------------------------------------------------------------------

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function parseNodeDns(raw: unknown): NodeDns {
  const row = asRecord(raw);
  const out: NodeDns = { search: asString(row.search) ?? '' };
  for (const key of ['dns1', 'dns2', 'dns3'] as const) {
    const value = asString(row[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function parseNodeTime(raw: unknown): NodeTime {
  const row = asRecord(raw);
  return {
    timezone: asString(row.timezone) ?? 'UTC',
    time: asNumber(row.time) ?? 0,
    localtime: asNumber(row.localtime) ?? 0,
  };
}

export function parseNodeOptions(raw: unknown): NodeOptions {
  const row = asRecord(raw);
  const out: NodeOptions = {};
  const description = asString(row.description);
  if (description !== undefined) out.description = description;
  const delay = asNumber(row['startall-onboot-delay']);
  if (delay !== undefined) out.startallOnbootDelay = delay;
  const wakeonlan = asString(row.wakeonlan);
  if (wakeonlan !== undefined) out.wakeonlan = wakeonlan;
  const target = asNumber(row['ballooning-target']);
  if (target !== undefined) out.ballooningTarget = target;
  const digest = asString(row.digest);
  if (digest !== undefined) out.digest = digest;
  return out;
}

export function parseNodeHosts(raw: unknown): NodeHosts {
  const row = asRecord(raw);
  const out: NodeHosts = { data: typeof row.data === 'string' ? row.data : '' };
  const digest = asString(row.digest);
  if (digest !== undefined) out.digest = digest;
  return out;
}

/** One `certificates/info` row; the `pem` is deliberately not carried into the UI. */
export function parseNodeCertificate(raw: unknown): NodeCertificate | undefined {
  const row = asRecord(raw);
  const filename = asString(row.filename);
  if (filename === undefined) return undefined;
  const out: NodeCertificate = {
    filename,
    san: Array.isArray(row.san) ? row.san.filter((s): s is string => typeof s === 'string') : [],
  };
  const fingerprint = asString(row.fingerprint);
  if (fingerprint !== undefined) out.fingerprint = fingerprint;
  const subject = asString(row.subject);
  if (subject !== undefined) out.subject = subject;
  const issuer = asString(row.issuer);
  if (issuer !== undefined) out.issuer = issuer;
  const notbefore = asNumber(row.notbefore);
  if (notbefore !== undefined) out.notbefore = notbefore;
  const notafter = asNumber(row.notafter);
  if (notafter !== undefined) out.notafter = notafter;
  const keyType = asString(row['public-key-type']);
  if (keyType !== undefined) out.publicKeyType = keyType;
  const keyBits = asNumber(row['public-key-bits']);
  if (keyBits !== undefined) out.publicKeyBits = keyBits;
  return out;
}

export function parseNodeCertificates(raw: unknown): NodeCertificate[] {
  const rows = Array.isArray(raw) ? raw : [];
  return rows.map(parseNodeCertificate).filter((row): row is NodeCertificate => row !== undefined);
}

// --- reads (through the read-only proxy) -------------------------------------------------------

async function readData(node: string, path: string, what: string): Promise<unknown> {
  const res = await fetch(`/api/pve/nodes/${encodeURIComponent(node)}/${path}`);
  if (!res.ok) throw new Error(`Failed to load the ${what} of ${node}: ${res.status}`);
  const envelope = asRecord(await res.json());
  return envelope.data;
}

export async function getNodeDns(node: string): Promise<NodeDns> {
  if (USE_FIXTURES) return parseNodeDns(getFixtureNodeDns(node));
  return parseNodeDns(await readData(node, 'dns', 'DNS settings'));
}

export async function getNodeTime(node: string): Promise<NodeTime> {
  if (USE_FIXTURES) return parseNodeTime(getFixtureNodeTime(node));
  return parseNodeTime(await readData(node, 'time', 'time settings'));
}

export async function getNodeOptions(node: string): Promise<NodeOptions> {
  if (USE_FIXTURES) return parseNodeOptions(getFixtureNodeConfig(node));
  return parseNodeOptions(await readData(node, 'config', 'options'));
}

export async function getNodeHosts(node: string): Promise<NodeHosts> {
  if (USE_FIXTURES) return parseNodeHosts(getFixtureNodeHosts(node));
  return parseNodeHosts(await readData(node, 'hosts', 'hosts file'));
}

export async function getNodeCertificates(node: string): Promise<NodeCertificate[]> {
  if (USE_FIXTURES) return parseNodeCertificates(getFixtureNodeCertificates(node));
  return parseNodeCertificates(await readData(node, 'certificates/info', 'certificates'));
}

// --- writes ------------------------------------------------------------------------------------

async function sendJson(url: string, method: 'PUT' | 'POST' | 'DELETE', body: unknown): Promise<void> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 200) return;
  return throwActionError(res);
}

const systemUrl = (node: string, path: string) => `/api/actions/node/${encodeURIComponent(node)}/system/${path}`;

/** `PUT /api/actions/node/:node/system/dns`. */
export async function updateNodeDns(node: string, body: UpdateDnsBody): Promise<void> {
  if (USE_FIXTURES) {
    fixtureCall(() => updateFixtureNodeDns(node, { ...body }));
    return;
  }
  return sendJson(systemUrl(node, 'dns'), 'PUT', body);
}

/** `PUT /api/actions/node/:node/system/time`. */
export async function updateNodeTime(node: string, body: UpdateTimeBody): Promise<void> {
  if (USE_FIXTURES) {
    fixtureCall(() => updateFixtureNodeTime(node, { ...body }));
    return;
  }
  return sendJson(systemUrl(node, 'time'), 'PUT', body);
}

/** `PUT /api/actions/node/:node/system/options`. */
export async function updateNodeOptions(node: string, body: UpdateOptionsBody): Promise<void> {
  if (USE_FIXTURES) {
    fixtureCall(() => updateFixtureNodeOptions(node, { ...body }));
    return;
  }
  return sendJson(systemUrl(node, 'options'), 'PUT', body);
}

/** `POST /api/actions/node/:node/system/hosts` (PVE replaces the whole file). */
export async function saveNodeHosts(node: string, body: SaveHostsBody): Promise<void> {
  if (USE_FIXTURES) {
    fixtureCall(() => saveFixtureNodeHosts(node, { ...body }));
    return;
  }
  return sendJson(systemUrl(node, 'hosts'), 'POST', body);
}

/** `POST /api/actions/node/:node/system/certificates`. */
export async function uploadNodeCertificate(node: string, body: UploadCertificateBody): Promise<void> {
  if (USE_FIXTURES) {
    fixtureCall(() => uploadFixtureNodeCertificate(node, { ...body }));
    return;
  }
  return sendJson(systemUrl(node, 'certificates'), 'POST', body);
}

/** `DELETE /api/actions/node/:node/system/certificates` (back to Proxmox's own certificate). */
export async function removeNodeCertificate(node: string, body: RemoveCertificateBody): Promise<void> {
  if (USE_FIXTURES) {
    fixtureCall(() => removeFixtureNodeCertificate(node));
    return;
  }
  return sendJson(systemUrl(node, 'certificates'), 'DELETE', body);
}
