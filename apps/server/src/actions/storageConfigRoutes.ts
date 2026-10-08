import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PveApiError, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import { formatPveErrorMessage, sanitizeMessage } from './shared.js';

/**
 * Datacenter -> Storage configuration (T70): add, edit and remove a storage definition. Three
 * allow-listed calls this server performs against PVE (`POST /storage`, `PUT /storage/{storage}`,
 * `DELETE /storage/{storage}`), registered from `actionsRoutes` (`routes.ts`) so they share its
 * rate limiter, same convention as `registerNetworkRoutes`. The raw `/api/pve/*` proxy stays
 * read-only; every PVE parameter is composed here from a validated, typed body -- the caller never
 * hands PVE a free-form property string. This is NOT the content browser (`storageRoutes.ts`).
 *
 * CIFS and PBS carry a password. It is sent to PVE exactly once, on the create/edit request, and
 * is never logged, never echoed in a response and never stored here: log lines name the storage id
 * and the changed KEYS only.
 *
 * Privilege (checked against the caller's own credentials, `GET /access/permissions`):
 * `Datastore.Allocate` on `/storage` to add, on `/storage/<id>` to edit or remove.
 */

const ALLOCATE_PRIVILEGE = 'Datastore.Allocate';

const STORAGE_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{1,63}$/;
const NODE_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;
const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const ABS_PATH_RE = /^\/[A-Za-z0-9._/-]+$/;
const EXPORT_RE = /^\/[A-Za-z0-9._/+@:=-]*$/;
const NFS_OPTIONS_RE = /^[A-Za-z0-9=,._-]+$/;
const SHARE_RE = /^[A-Za-z0-9._$-][A-Za-z0-9._$ -]{0,79}$/;
const SUBDIR_RE = /^\/[A-Za-z0-9._/ -]*$/;
const CIFS_USER_RE = /^[A-Za-z0-9._@\\-]{1,128}$/;
const DOMAIN_RE = /^[A-Za-z0-9._-]{1,255}$/;
const VG_RE = /^[A-Za-z0-9._+-]+$/;
const ZFS_POOL_RE = /^[A-Za-z0-9._/-]+$/;
const BLOCKSIZE_RE = /^\d+[kKmM]?$/;
const PBS_DATASTORE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PBS_USER_RE = /^[^\s@]+@[^\s@]+$/;
const PBS_NAMESPACE_RE = /^[A-Za-z0-9._/-]{1,256}$/;
const FINGERPRINT_RE = /^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/;

export const CONTENT_TYPES = ['images', 'rootdir', 'vztmpl', 'backup', 'iso', 'snippets', 'import'] as const;
type ContentType = (typeof CONTENT_TYPES)[number];

const FILE_CONTENT: readonly ContentType[] = CONTENT_TYPES;
const BLOCK_CONTENT: readonly ContentType[] = ['images', 'rootdir'];
const PBS_CONTENT: readonly ContentType[] = ['backup'];

const SMB_VERSIONS = ['2.0', '2.1', '3', '3.0', '3.11', 'default'] as const;
const PREALLOCATIONS = ['off', 'metadata', 'falloc', 'full'] as const;

function contentSchema(allowed: readonly ContentType[]) {
  return z
    .array(z.enum(CONTENT_TYPES))
    .min(1)
    .max(CONTENT_TYPES.length)
    .refine((list) => list.every((c) => allowed.includes(c)), {
      message: 'Content type not supported by this storage type',
    })
    .refine((list) => new Set(list).size === list.length, { message: 'Duplicate content type' });
}

const storageIdSchema = z.string().regex(STORAGE_ID_RE);
/** An absolute path with no `..` segment. */
const absPathSchema = z
  .string()
  .max(1024)
  .regex(ABS_PATH_RE)
  .refine((v) => !v.split('/').includes('..'), { message: 'Path must not contain ..' });
const nodesSchema = z.array(z.string().regex(NODE_RE)).max(64);
const hostSchema = z
  .string()
  .max(253)
  .refine((v) => isIP(v) !== 0 || HOSTNAME_RE.test(v), { message: 'Invalid host' });

/** The keep-* retention shape, shared by every backup-capable storage type. */
const keepCount = z.number().int().min(0).max(365);
const pruneSchema = z
  .object({
    keepAll: z.boolean().optional(),
    keepLast: keepCount.optional(),
    keepHourly: keepCount.optional(),
    keepDaily: keepCount.optional(),
    keepWeekly: keepCount.optional(),
    keepMonthly: keepCount.optional(),
    keepYearly: keepCount.optional(),
  })
  .strict()
  .refine(
    (p) =>
      p.keepAll !== true ||
      (p.keepLast === undefined &&
        p.keepHourly === undefined &&
        p.keepDaily === undefined &&
        p.keepWeekly === undefined &&
        p.keepMonthly === undefined &&
        p.keepYearly === undefined),
    { message: 'keepAll cannot be combined with the other keep-* values' },
  );
type PruneBody = z.infer<typeof pruneSchema>;

/** `keep-last=3,keep-daily=7`, or `keep-all=1`; `undefined` when nothing is set. */
export function composePruneBackups(prune: PruneBody): string | undefined {
  if (prune.keepAll === true) return 'keep-all=1';
  const parts: string[] = [];
  if (prune.keepLast !== undefined) parts.push(`keep-last=${prune.keepLast}`);
  if (prune.keepHourly !== undefined) parts.push(`keep-hourly=${prune.keepHourly}`);
  if (prune.keepDaily !== undefined) parts.push(`keep-daily=${prune.keepDaily}`);
  if (prune.keepWeekly !== undefined) parts.push(`keep-weekly=${prune.keepWeekly}`);
  if (prune.keepMonthly !== undefined) parts.push(`keep-monthly=${prune.keepMonthly}`);
  if (prune.keepYearly !== undefined) parts.push(`keep-yearly=${prune.keepYearly}`);
  return parts.length > 0 ? parts.join(',') : undefined;
}

const commonAdd = {
  storage: storageIdSchema,
  nodes: nodesSchema.optional(),
  disable: z.boolean().optional(),
};

const passwordField = z.string().min(1).max(1024);

// `.strict()`: an unknown key is a 400, same rationale as every other action body schema.
const addBodySchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('dir'),
      ...commonAdd,
      path: absPathSchema,
      content: contentSchema(FILE_CONTENT),
      shared: z.boolean().optional(),
      preallocation: z.enum(PREALLOCATIONS).optional(),
      prune: pruneSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('nfs'),
      ...commonAdd,
      server: hostSchema,
      export: z.string().max(1024).regex(EXPORT_RE),
      content: contentSchema(FILE_CONTENT),
      options: z.string().max(512).regex(NFS_OPTIONS_RE).optional(),
      prune: pruneSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('cifs'),
      ...commonAdd,
      server: hostSchema,
      share: z.string().regex(SHARE_RE),
      username: z.string().regex(CIFS_USER_RE).optional(),
      password: passwordField.optional(),
      domain: z.string().regex(DOMAIN_RE).optional(),
      subdir: z.string().max(1024).regex(SUBDIR_RE).optional(),
      smbversion: z.enum(SMB_VERSIONS).optional(),
      content: contentSchema(FILE_CONTENT),
      prune: pruneSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('lvm'),
      ...commonAdd,
      vgname: z.string().max(100).regex(VG_RE),
      base: z.string().max(200).regex(/^[A-Za-z0-9._+:/-]+$/).optional(),
      content: contentSchema(BLOCK_CONTENT),
      shared: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('lvmthin'),
      ...commonAdd,
      vgname: z.string().max(100).regex(VG_RE),
      thinpool: z.string().max(100).regex(VG_RE),
      content: contentSchema(BLOCK_CONTENT),
    })
    .strict(),
  z
    .object({
      type: z.literal('zfspool'),
      ...commonAdd,
      pool: z.string().max(200).regex(ZFS_POOL_RE),
      content: contentSchema(BLOCK_CONTENT),
      sparse: z.boolean().optional(),
      blocksize: z.string().regex(BLOCKSIZE_RE).optional(),
      mountpoint: absPathSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('pbs'),
      ...commonAdd,
      server: hostSchema,
      datastore: z.string().regex(PBS_DATASTORE_RE),
      username: z.string().max(256).regex(PBS_USER_RE),
      password: passwordField,
      fingerprint: z.string().regex(FINGERPRINT_RE).optional(),
      namespace: z.string().regex(PBS_NAMESPACE_RE).optional(),
      content: contentSchema(PBS_CONTENT),
      prune: pruneSchema.optional(),
    })
    .strict(),
]);
type AddBody = z.infer<typeof addBodySchema>;

type PveForm = Record<string, string | number | boolean>;

/** The `POST /storage` form for a validated body: PVE's own parameter names, keys in a stable
 * order, unset fields omitted. A `false` boolean is omitted (PVE's default) rather than sent. */
export function composeAddForm(body: AddBody): PveForm {
  const form: PveForm = { storage: body.storage, type: body.type };
  switch (body.type) {
    case 'dir':
      form.path = body.path;
      break;
    case 'nfs':
      form.server = body.server;
      form.export = body.export;
      break;
    case 'cifs':
      form.server = body.server;
      form.share = body.share;
      break;
    case 'lvm':
      form.vgname = body.vgname;
      break;
    case 'lvmthin':
      form.vgname = body.vgname;
      form.thinpool = body.thinpool;
      break;
    case 'zfspool':
      form.pool = body.pool;
      break;
    case 'pbs':
      form.server = body.server;
      form.datastore = body.datastore;
      break;
  }
  form.content = body.content.join(',');
  if (body.nodes !== undefined && body.nodes.length > 0) form.nodes = body.nodes.join(',');
  if (body.disable === true) form.disable = true;
  if ('shared' in body && body.shared === true) form.shared = true;
  if ('preallocation' in body && body.preallocation !== undefined) form.preallocation = body.preallocation;
  if ('options' in body && body.options !== undefined) form.options = body.options;
  if ('username' in body && body.username !== undefined) form.username = body.username;
  if ('password' in body && body.password !== undefined) form.password = body.password;
  if ('domain' in body && body.domain !== undefined) form.domain = body.domain;
  if ('subdir' in body && body.subdir !== undefined) form.subdir = body.subdir;
  if ('smbversion' in body && body.smbversion !== undefined) form.smbversion = body.smbversion;
  if ('base' in body && body.base !== undefined) form.base = body.base;
  if ('sparse' in body && body.sparse === true) form.sparse = true;
  if ('blocksize' in body && body.blocksize !== undefined) form.blocksize = body.blocksize;
  if ('mountpoint' in body && body.mountpoint !== undefined) form.mountpoint = body.mountpoint;
  if ('fingerprint' in body && body.fingerprint !== undefined) form.fingerprint = body.fingerprint;
  if ('namespace' in body && body.namespace !== undefined) form.namespace = body.namespace;
  if ('prune' in body && body.prune !== undefined) {
    const prune = composePruneBackups(body.prune);
    if (prune !== undefined) form['prune-backups'] = prune;
  }
  return form;
}

// --- edit -------------------------------------------------------------------------------------

/** "Leave the stored password alone" -- PVE keeps a secret that is simply not sent. */
const keepSchema = z.object({ keep: z.literal(true) }).strict();

/**
 * One superset schema for every storage type; the per-type guard (which fields apply, which
 * content types are allowed) lives in the handler, where the storage's type is known (it is read
 * from PVE, never taken from the caller). `null` clears a property (PVE `delete` list).
 */
const editBodySchema = z
  .object({
    content: z.array(z.enum(CONTENT_TYPES)).min(1).max(CONTENT_TYPES.length).optional(),
    nodes: nodesSchema.nullable().optional(),
    disable: z.boolean().optional(),
    shared: z.boolean().optional(),
    options: z.string().max(512).regex(NFS_OPTIONS_RE).nullable().optional(),
    prune: pruneSchema.nullable().optional(),
    preallocation: z.enum(PREALLOCATIONS).nullable().optional(),
    bwlimit: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
    username: z.string().max(256).nullable().optional(),
    password: z.union([passwordField, keepSchema]).nullable().optional(),
    domain: z.string().regex(DOMAIN_RE).nullable().optional(),
    smbversion: z.enum(SMB_VERSIONS).nullable().optional(),
    fingerprint: z.string().regex(FINGERPRINT_RE).nullable().optional(),
    namespace: z.string().regex(PBS_NAMESPACE_RE).nullable().optional(),
    sparse: z.boolean().optional(),
  })
  .strict();
type EditBody = z.infer<typeof editBodySchema>;

type EditKey = keyof EditBody;
const COMMON_EDIT: readonly EditKey[] = ['content', 'nodes', 'disable', 'bwlimit'];
const TYPE_EDIT: Record<string, readonly EditKey[]> = {
  dir: ['shared', 'preallocation', 'prune'],
  nfs: ['options', 'preallocation', 'prune'],
  cifs: ['username', 'password', 'domain', 'smbversion', 'preallocation', 'prune'],
  lvm: ['shared'],
  lvmthin: [],
  zfspool: ['sparse'],
  pbs: ['username', 'password', 'fingerprint', 'namespace', 'prune'],
};
const TYPE_CONTENT: Record<string, readonly ContentType[]> = {
  dir: FILE_CONTENT,
  nfs: FILE_CONTENT,
  cifs: FILE_CONTENT,
  lvm: BLOCK_CONTENT,
  lvmthin: BLOCK_CONTENT,
  zfspool: BLOCK_CONTENT,
  pbs: PBS_CONTENT,
};

interface EditForm {
  form: PveForm;
  /** PVE property names the request sets or deletes (never values). */
  changed: string[];
}

/** The `PUT /storage/{storage}` form for a validated body: set values, plus the `delete` list for
 * every property the caller cleared (`null`, an empty `nodes`, an empty `prune`). */
export function composeEditForm(body: EditBody): EditForm {
  const form: PveForm = {};
  const cleared: string[] = [];
  const changed: string[] = [];

  function set(key: string, value: string | number | boolean): void {
    form[key] = value;
    changed.push(key);
  }
  function clear(key: string): void {
    cleared.push(key);
    changed.push(key);
  }

  if (body.content !== undefined) set('content', body.content.join(','));
  if (body.nodes !== undefined) {
    if (body.nodes === null || body.nodes.length === 0) clear('nodes');
    else set('nodes', body.nodes.join(','));
  }
  if (body.disable !== undefined) set('disable', body.disable);
  if (body.shared !== undefined) set('shared', body.shared);
  if (body.sparse !== undefined) set('sparse', body.sparse);

  const nullable: Array<[string, string | number | null | undefined]> = [
    ['options', body.options],
    ['preallocation', body.preallocation],
    ['bwlimit', body.bwlimit],
    ['username', body.username],
    ['domain', body.domain],
    ['smbversion', body.smbversion],
    ['fingerprint', body.fingerprint],
    ['namespace', body.namespace],
  ];
  for (const [key, value] of nullable) {
    if (value === undefined) continue;
    if (value === null) clear(key);
    else set(key, value);
  }

  if (body.prune !== undefined) {
    const prune = body.prune === null ? undefined : composePruneBackups(body.prune);
    if (prune === undefined) clear('prune-backups');
    else set('prune-backups', prune);
  }

  // `{ keep: true }` sends nothing: PVE keeps the stored secret. A string replaces it; `null` deletes it.
  if (body.password !== undefined && !(typeof body.password === 'object' && body.password !== null)) {
    if (body.password === null) clear('password');
    else set('password', body.password);
  }

  if (cleared.length > 0) form.delete = cleared.join(',');
  return { form, changed };
}

// --- plumbing ---------------------------------------------------------------------------------

/** Same `502`/`4xx` mapping every action route uses; `true` iff it sent a reply. */
function sendPveError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof PveApiError) {
    if (error.status >= 500) {
      reply.code(502).send({ error: 'pve-unreachable' });
    } else {
      reply.code(error.status).send({ error: 'pve-rejected', message: sanitizeMessage(formatPveErrorMessage(error)) });
    }
    return true;
  }
  return false;
}

/** Whether the caller's own credentials hold `privilege` on an ACL `path` (`/storage`,
 * `/storage/<id>`, ...), via `GET /access/permissions?path=`. Real PVE nests the result under the
 * requested path; falls back to a flat map like `shared.ts`'s helpers. Local to this file. */
async function hasPathPrivilege(client: PveClient, path: string, privilege: string): Promise<boolean> {
  const perms = (await client.get('/access/permissions', { path })) as Record<string, unknown>;
  const scoped = (perms[path] as Record<string, unknown> | undefined) ?? perms;
  return Boolean(scoped[privilege]);
}

/** The shared session/token/privilege gate. Sends the failure reply itself and returns
 * `undefined`; otherwise returns the caller's identity. */
async function authorize(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply, aclPath: string) {
  const identity = await resolveIdentity(app, req);
  if (!identity) {
    reply.code(401).send({ error: 'Not authenticated' });
    return undefined;
  }
  if (identity.credentials.type === 'token') {
    reply.code(403).send({ error: 'writes-disabled-in-token-mode' });
    return undefined;
  }
  let allowed: boolean;
  try {
    allowed = await hasPathPrivilege(identity.client, aclPath, ALLOCATE_PRIVILEGE);
  } catch (error) {
    if (sendPveError(reply, error)) return undefined;
    app.log.warn({ err: error }, 'Failed to check permissions for storage configuration');
    reply.code(502).send({ error: 'pve-unreachable' });
    return undefined;
  }
  if (!allowed) {
    reply.code(403).send({ error: 'forbidden', missing: ALLOCATE_PRIVILEGE });
    return undefined;
  }
  return identity;
}

export function registerStorageConfigRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  app.post('/api/actions/datacenter/storage', { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const parsed = addBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid request body' });
      return;
    }
    const body = parsed.data;

    const identity = await authorize(app, req, reply, '/storage');
    if (!identity) return;

    try {
      await identity.client.post('/storage', composeAddForm(body) as never);
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'Storage add request failed');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    // One line per add; the id and type only -- never the server, share, username or password.
    app.log.info({ username: identity.username, storage: body.storage, type: body.type }, 'Storage added');
    reply.code(200).send({ ok: true, storage: body.storage });
  });

  app.put('/api/actions/datacenter/storage/:storage', { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const storage = (req.params as Record<string, string>).storage ?? '';
    if (!STORAGE_ID_RE.test(storage)) {
      reply.code(400).send({ error: 'Invalid storage id' });
      return;
    }
    const parsed = editBodySchema.safeParse(req.body ?? {});
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      reply.code(400).send({ error: 'Invalid request body' });
      return;
    }
    const body = parsed.data;

    const identity = await authorize(app, req, reply, `/storage/${storage}`);
    if (!identity) return;
    const client = identity.client;

    // The storage's type decides which fields apply; it is read from PVE, never taken from the caller.
    let type: string;
    try {
      const current = (await client.get('/storage/{storage}', { storage })) as Record<string, unknown>;
      type = typeof current.type === 'string' ? current.type : '';
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'Failed to read current storage configuration');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    const allowedKeys = new Set<EditKey>([...COMMON_EDIT, ...(TYPE_EDIT[type] ?? [])]);
    const wrongFields = (Object.keys(body) as EditKey[]).filter((key) => !allowedKeys.has(key));
    if (wrongFields.length > 0) {
      reply.code(400).send({
        error: 'invalid-field-for-type',
        message: `${wrongFields.join(', ')} ${wrongFields.length === 1 ? 'is' : 'are'} not valid for a ${type || 'this'} storage.`,
      });
      return;
    }
    const contentAllowed = TYPE_CONTENT[type] ?? FILE_CONTENT;
    if (body.content !== undefined) {
      const ok =
        body.content.every((c) => contentAllowed.includes(c)) && new Set(body.content).size === body.content.length;
      if (!ok) {
        reply.code(400).send({
          error: 'invalid-content',
          message: `A ${type || 'this'} storage supports: ${contentAllowed.join(', ')}.`,
        });
        return;
      }
    }

    const { form, changed } = composeEditForm(body);
    if (changed.length === 0) {
      // Only `password: { keep: true }`: nothing to send.
      reply.code(200).send({ ok: true, storage, changed });
      return;
    }

    try {
      await client.put('/storage/{storage}', { storage, ...form } as never);
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'Storage edit request failed');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    // Changed KEYS only -- never a value (an NFS option string or a password may sit in one).
    app.log.info({ username: identity.username, storage, type, changed }, 'Storage updated');
    reply.code(200).send({ ok: true, storage, changed });
  });

  app.delete('/api/actions/datacenter/storage/:storage', { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const storage = (req.params as Record<string, string>).storage ?? '';
    if (!STORAGE_ID_RE.test(storage)) {
      reply.code(400).send({ error: 'Invalid storage id' });
      return;
    }
    if (storage === 'local') {
      reply.code(400).send({
        error: 'cannot-remove-local',
        message: 'The built-in "local" storage holds the node itself and cannot be removed here.',
      });
      return;
    }

    const identity = await authorize(app, req, reply, `/storage/${storage}`);
    if (!identity) return;

    try {
      // PVE removes the definition only; the data on the storage is never deleted.
      await identity.client.delete('/storage/{storage}', { storage });
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'Storage removal request failed');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    app.log.info({ username: identity.username, storage }, 'Storage definition removed');
    reply.code(200).send({ ok: true });
  });
}
