import { USE_FIXTURES } from '@/api/client';
import { GuestActionError } from '@/api/actions';
import {
  FIXTURE_ACCESS_SELF,
  addFixtureAccessGroup,
  addFixtureAccessToken,
  addFixtureAccessUser,
  applyFixtureAccessAcl,
  getFixtureAccessAcl,
  getFixtureAccessGroups,
  getFixtureAccessPools,
  getFixtureAccessRealms,
  getFixtureAccessRoles,
  getFixtureAccessUsers,
  patchFixtureAccessGroup,
  patchFixtureAccessToken,
  patchFixtureAccessUser,
  removeFixtureAccessGroup,
  removeFixtureAccessToken,
  removeFixtureAccessUser,
  type AccessAclEntry,
  type AccessGroup,
  type AccessRealm,
  type AccessRole,
  type AccessToken,
  type AccessUser,
} from '@/api/fixtures';

export type { AccessAclEntry, AccessGroup, AccessRealm, AccessRole, AccessToken, AccessUser };
export { FIXTURE_ACCESS_SELF };

/**
 * Datacenter -> Users & Permissions (T68): the web side of `/api/actions/datacenter/access/*`
 * (`apps/server/src/actions/accessRoutes.ts`) plus the read-only lists the tab renders (through
 * the `/api/pve/*` proxy). Fixture mode is handled inline in each function (same convention as
 * `network.ts`). A password is only ever put in a request body; a created token's secret is only
 * ever returned to the caller of `createToken` -- neither is kept in any list or fixture record.
 */

const BASE = '/api/actions/datacenter/access';

// --- bodies / results -------------------------------------------------------------------------

export interface CreateUserBody {
  /** `name@realm`. */
  userid: string;
  /** pve realm only; 8..64 characters. */
  password?: string;
  enable?: boolean;
  /** Unix seconds; `0` = never expires. */
  expire?: number;
  firstname?: string;
  lastname?: string;
  email?: string;
  groups?: string[];
  comment?: string;
}

/** An explicit `null` clears the field. */
export interface UpdateUserBody {
  enable?: boolean;
  expire?: number | null;
  firstname?: string | null;
  lastname?: string | null;
  email?: string | null;
  groups?: string[] | null;
  comment?: string | null;
}

export interface ChangePasswordBody {
  userid: string;
  password: string;
  /** The signed-in user's CURRENT password (PVE requires it for a self-service change). */
  confirmationPassword?: string;
}

export interface AclBody {
  path: string;
  roles: string[];
  /** Exactly one of users / groups / tokens (full token ids). */
  users?: string[];
  groups?: string[];
  tokens?: string[];
  propagate?: boolean;
  remove?: boolean;
}

export interface CreateTokenBody {
  tokenid: string;
  comment?: string;
  expire?: number;
  privsep?: boolean;
}

export interface UpdateTokenBody {
  comment?: string;
  expire?: number;
  privsep?: boolean;
}

/** What `createToken` resolves with. `value` is the secret and is shown to the user exactly once. */
export interface CreatedToken {
  fullTokenid: string;
  value: string;
}

interface AccessErrorBody {
  error?: string;
  message?: string;
  missing?: string;
}

function describeError(status: number, statusText: string, body: AccessErrorBody | undefined): string {
  if (body?.message) return body.message;
  switch (body?.error) {
    case 'writes-disabled-in-token-mode':
      return 'Read-only: signed in with a service token';
    case 'forbidden':
      return body.missing ? `You don't have ${body.missing} for this` : "You don't have permission for this";
    case 'pve-unreachable':
      return 'Proxmox VE is unreachable';
    case 'Invalid request body':
      return 'The request was not valid';
    default:
      return body?.error ?? `Request failed: ${status} ${statusText}`;
  }
}

async function throwActionError(res: Response): Promise<never> {
  let errorBody: AccessErrorBody | undefined;
  try {
    errorBody = (await res.json()) as AccessErrorBody;
  } catch {
    errorBody = undefined;
  }
  throw new GuestActionError(res.status, describeError(res.status, res.statusText, errorBody));
}

async function send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, init);
  if (res.status === 200) return (await res.json()) as T;
  return throwActionError(res);
}

const enc = encodeURIComponent;

// --- reads (read-only proxy) ------------------------------------------------------------------

async function readList(path: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`/api/pve${path}`);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  const envelope = (await res.json()) as { data?: unknown };
  return Array.isArray(envelope.data) ? (envelope.data as Array<Record<string, unknown>>) : [];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const flag = (v: unknown, fallback: boolean): boolean => (v === undefined || v === null ? fallback : v === 1 || v === true || v === '1');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' && v !== '' ? v.split(',') : [];

function normalizeToken(raw: Record<string, unknown>): AccessToken | undefined {
  const tokenid = str(raw.tokenid);
  if (!tokenid) return undefined;
  const token: AccessToken = { tokenid, expire: num(raw.expire), privsep: flag(raw.privsep, true) };
  const comment = str(raw.comment);
  if (comment) token.comment = comment;
  return token;
}

/** `GET /access/users?full=1` -- also carries each user's API tokens. */
export async function getUsers(): Promise<AccessUser[]> {
  if (USE_FIXTURES) return getFixtureAccessUsers();
  const rows = await readList('/access/users?full=1');
  const users: AccessUser[] = [];
  for (const row of rows) {
    const userid = str(row.userid);
    if (!userid) continue;
    const user: AccessUser = {
      userid,
      enable: flag(row.enable, true),
      expire: num(row.expire),
      groups: list(row.groups),
      tokens: (Array.isArray(row.tokens) ? (row.tokens as Array<Record<string, unknown>>) : [])
        .map(normalizeToken)
        .filter((t): t is AccessToken => t !== undefined),
    };
    for (const key of ['firstname', 'lastname', 'email', 'comment'] as const) {
      const value = str(row[key]);
      if (value) user[key] = value;
    }
    users.push(user);
  }
  return users.sort((a, b) => a.userid.localeCompare(b.userid));
}

/** `GET /access/groups`. */
export async function getGroups(): Promise<AccessGroup[]> {
  if (USE_FIXTURES) return getFixtureAccessGroups();
  const rows = await readList('/access/groups');
  return rows
    .map((row): AccessGroup | undefined => {
      const groupid = str(row.groupid);
      if (!groupid) return undefined;
      const group: AccessGroup = { groupid };
      const comment = str(row.comment);
      if (comment) group.comment = comment;
      return group;
    })
    .filter((g): g is AccessGroup => g !== undefined)
    .sort((a, b) => a.groupid.localeCompare(b.groupid));
}

/** `GET /access/roles`. */
export async function getRoles(): Promise<AccessRole[]> {
  if (USE_FIXTURES) return getFixtureAccessRoles();
  const rows = await readList('/access/roles');
  return rows
    .map((row): AccessRole | undefined => {
      const roleid = str(row.roleid);
      return roleid ? { roleid, privs: list(row.privs).sort(), special: flag(row.special, false) } : undefined;
    })
    .filter((r): r is AccessRole => r !== undefined)
    .sort((a, b) => a.roleid.localeCompare(b.roleid));
}

/** `GET /access/acl`. */
export async function getAcl(): Promise<AccessAclEntry[]> {
  if (USE_FIXTURES) return getFixtureAccessAcl();
  const rows = await readList('/access/acl');
  const entries: AccessAclEntry[] = [];
  for (const row of rows) {
    const path = str(row.path);
    const ugid = str(row.ugid);
    const roleid = str(row.roleid);
    const type = row.type;
    if (!path || !ugid || !roleid || (type !== 'user' && type !== 'group' && type !== 'token')) continue;
    entries.push({ path, ugid, roleid, type, propagate: flag(row.propagate, true) });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path) || a.ugid.localeCompare(b.ugid) || a.roleid.localeCompare(b.roleid));
}

/** `GET /access/domains` -- the realms a user can belong to. */
export async function getRealms(): Promise<AccessRealm[]> {
  if (USE_FIXTURES) return getFixtureAccessRealms();
  const rows = await readList('/access/domains');
  return rows
    .map((row): AccessRealm | undefined => {
      const realm = str(row.realm);
      const type = str(row.type);
      if (!realm || !type) return undefined;
      const out: AccessRealm = { realm, type };
      const comment = str(row.comment);
      if (comment) out.comment = comment;
      return out;
    })
    .filter((r): r is AccessRealm => r !== undefined);
}

/** `GET /pools` -- pool ids, for the permission path suggestions. Best-effort: empty on failure. */
export async function getPoolIds(): Promise<string[]> {
  if (USE_FIXTURES) return getFixtureAccessPools();
  try {
    const rows = await readList('/pools');
    return rows.map((r) => str(r.poolid)).filter((p): p is string => p !== undefined).sort();
  } catch {
    return [];
  }
}

// --- fixture helpers --------------------------------------------------------------------------

function fixtureFail(status: number, message: string): never {
  throw new GuestActionError(status, message);
}

/** A uuid-shaped throwaway secret for the demo; never stored anywhere. */
function fixtureSecret(): string {
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
}

// --- users ------------------------------------------------------------------------------------

/** `POST .../users`. */
export async function createUser(body: CreateUserBody): Promise<{ ok: true; userid: string }> {
  if (USE_FIXTURES) {
    // The password (if any) is checked for presence only -- it is never copied into the record.
    const { password, userid, groups, ...rest } = body;
    void password;
    const record: AccessUser = { userid, enable: true, expire: 0, groups: groups ?? [], tokens: [], ...rest };
    if (!addFixtureAccessUser(record)) fixtureFail(400, `User ${userid} already exists`);
    return { ok: true, userid };
  }
  return send('POST', '/users', body);
}

/** `PUT .../users/:userid`. */
export async function updateUser(userid: string, body: UpdateUserBody): Promise<{ ok: true }> {
  if (USE_FIXTURES) {
    const patch: Partial<Record<keyof AccessUser, unknown>> = {};
    if (body.enable !== undefined) patch.enable = body.enable;
    if (body.expire !== undefined) patch.expire = body.expire ?? 0;
    for (const key of ['firstname', 'lastname', 'email', 'comment'] as const) {
      const value = body[key];
      if (value !== undefined) patch[key] = value === null || value === '' ? undefined : value;
    }
    if (body.groups !== undefined) patch.groups = body.groups ?? [];
    if (!patchFixtureAccessUser(userid, patch)) fixtureFail(404, `User ${userid} does not exist`);
    return { ok: true };
  }
  return send('PUT', `/users/${enc(userid)}`, body);
}

/** `DELETE .../users/:userid`. */
export async function deleteUser(userid: string): Promise<{ ok: true }> {
  if (USE_FIXTURES) {
    if (userid === 'root@pam') fixtureFail(400, 'root@pam cannot be deleted.');
    if (userid === FIXTURE_ACCESS_SELF) fixtureFail(400, 'You cannot delete the account you are signed in with.');
    if (!removeFixtureAccessUser(userid)) fixtureFail(404, `User ${userid} does not exist`);
    return { ok: true };
  }
  return send('DELETE', `/users/${enc(userid)}`);
}

/** `PUT .../password`. The password goes in the request body only. */
export async function changePassword(body: ChangePasswordBody): Promise<{ ok: true }> {
  if (USE_FIXTURES) {
    if (!getFixtureAccessUsers().some((u) => u.userid === body.userid)) fixtureFail(404, `User ${body.userid} does not exist`);
    return { ok: true };
  }
  return send('PUT', '/password', body);
}

// --- groups -----------------------------------------------------------------------------------

/** `POST .../groups`. */
export async function createGroup(body: { groupid: string; comment?: string }): Promise<{ ok: true; groupid: string }> {
  if (USE_FIXTURES) {
    const group: AccessGroup = { groupid: body.groupid };
    if (body.comment) group.comment = body.comment;
    if (!addFixtureAccessGroup(group)) fixtureFail(400, `Group ${body.groupid} already exists`);
    return { ok: true, groupid: body.groupid };
  }
  return send('POST', '/groups', body);
}

/** `PUT .../groups/:groupid`. An empty `comment` clears it. */
export async function updateGroup(groupid: string, body: { comment: string }): Promise<{ ok: true }> {
  if (USE_FIXTURES) {
    if (!patchFixtureAccessGroup(groupid, body.comment)) fixtureFail(404, `Group ${groupid} does not exist`);
    return { ok: true };
  }
  return send('PUT', `/groups/${enc(groupid)}`, body);
}

/** `DELETE .../groups/:groupid`. */
export async function deleteGroup(groupid: string): Promise<{ ok: true }> {
  if (USE_FIXTURES) {
    if (!removeFixtureAccessGroup(groupid)) fixtureFail(404, `Group ${groupid} does not exist`);
    return { ok: true };
  }
  return send('DELETE', `/groups/${enc(groupid)}`);
}

// --- ACL --------------------------------------------------------------------------------------

/** `POST .../acl` -- adds (or, with `remove: true`, removes) role assignments on a path. */
export async function setAcl(body: AclBody): Promise<{ ok: true }> {
  if (USE_FIXTURES) {
    const type = body.users ? 'user' : body.groups ? 'group' : 'token';
    const ugids = body.users ?? body.groups ?? body.tokens ?? [];
    applyFixtureAccessAcl(
      { path: body.path, roles: body.roles, type, ugids, propagate: body.propagate ?? true },
      body.remove === true,
    );
    return { ok: true };
  }
  return send('POST', '/acl', body);
}

// --- API tokens -------------------------------------------------------------------------------

/** `POST .../users/:userid/tokens` -- resolves with the secret, which exists nowhere else. */
export async function createToken(userid: string, body: CreateTokenBody): Promise<CreatedToken> {
  if (USE_FIXTURES) {
    const token: AccessToken = { tokenid: body.tokenid, expire: body.expire ?? 0, privsep: body.privsep ?? true };
    if (body.comment) token.comment = body.comment;
    const result = addFixtureAccessToken(userid, token);
    if (result === 'no-user') fixtureFail(404, `User ${userid} does not exist`);
    if (result === 'exists') fixtureFail(400, `Token ${userid}!${body.tokenid} already exists`);
    return { fullTokenid: `${userid}!${body.tokenid}`, value: fixtureSecret() };
  }
  return send('POST', `/users/${enc(userid)}/tokens`, body);
}

/** `PUT .../users/:userid/tokens/:tokenid`. */
export async function updateToken(userid: string, tokenid: string, body: UpdateTokenBody): Promise<{ ok: true }> {
  if (USE_FIXTURES) {
    const patch: Partial<AccessToken> = {};
    if (body.expire !== undefined) patch.expire = body.expire;
    if (body.privsep !== undefined) patch.privsep = body.privsep;
    if (body.comment !== undefined) patch.comment = body.comment;
    if (!patchFixtureAccessToken(userid, tokenid, patch)) fixtureFail(404, `Token ${userid}!${tokenid} does not exist`);
    return { ok: true };
  }
  return send('PUT', `/users/${enc(userid)}/tokens/${enc(tokenid)}`, body);
}

/** `DELETE .../users/:userid/tokens/:tokenid`. */
export async function deleteToken(userid: string, tokenid: string): Promise<{ ok: true }> {
  if (USE_FIXTURES) {
    if (!removeFixtureAccessToken(userid, tokenid)) fixtureFail(404, `Token ${userid}!${tokenid} does not exist`);
    return { ok: true };
  }
  return send('DELETE', `/users/${enc(userid)}/tokens/${enc(tokenid)}`);
}

/** The userid's realm (`chris@pve` -> `pve`). */
export function realmOf(userid: string): string {
  return userid.slice(userid.lastIndexOf('@') + 1);
}
