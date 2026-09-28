import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PveApiError, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import { hasPrivilege, hasStoragePrivilege, sanitizeMessage } from './shared.js';

/**
 * Storage upload / download-from-URL / delete (T32) -- three more allow-listed writes this
 * server performs against PVE, registered from `actionsRoutes` (`routes.ts`) so they share its
 * rate limiter, same convention as `registerSnapshotRoutes`/`registerMigrateRoutes`/
 * `registerNodeRoutes`. See "Storage browser" in README.md for the full contract.
 */

/** Same shape/rationale as `NODE_NAME_RE` in `migrateRoutes.ts`/`nodeRoutes.ts` (kept local --
 * `:node` here is a routed path segment fastify already constrains no further than a generic
 * string, and the query-url-metadata route's `:node` is exactly the same shape). */
const NODE_NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const nodeNameSchema = z.string().min(1).max(63).regex(NODE_NAME_RE);

/** Same shape/rationale as `STORAGE_ID_RE` in `migrateRoutes.ts`. */
const STORAGE_ID_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;
const storageIdSchema = z.string().min(1).max(100).regex(STORAGE_ID_RE);

const uploadContentSchema = z.enum(['iso', 'vztmpl', 'import']);

/** A `filename` query/body value this server will forward to PVE: starts with an alphanumeric,
 * then letters/digits/`_`/`.`/`+`/`-`, up to 255 characters, and never containing `..` (the regex
 * alone permits consecutive dots -- e.g. `a..iso` -- so that's rejected separately below). PVE
 * enforces its own extension rules on top of this; this is just enough to keep the server from
 * ever forwarding an upload/download it can't even describe (e.g. a path-traversal-shaped name). */
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,254}$/;
const filenameSchema = z
  .string()
  .max(255)
  .regex(FILENAME_RE)
  .refine((value) => !value.includes('..'), { message: 'filename must not contain ".."' });

const CHECKSUM_ALGORITHMS = z.enum(['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512']);

/** `url` as accepted by both `download-url` and `query-url-metadata`: an absolute http(s) URL, up
 * to 2048 characters. */
const urlSchema = z
  .string()
  .max(2048)
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'url must be an absolute http or https URL' },
  );

// `.strict()`: an unknown key is a 400, same rationale as every other guest-action body schema in
// this app (see `shared.ts`'s doc comment, `routes.ts`, `migrateRoutes.ts`). The refine requires
// `checksum`/`checksumAlgorithm` to travel together -- PVE's own `download-url` endpoint takes a
// `checksum-algorithm` alongside `checksum`, and a checksum with no declared algorithm (or vice
// versa) is meaningless.
const downloadUrlBodySchema = z
  .object({
    url: urlSchema,
    content: uploadContentSchema,
    filename: filenameSchema,
    checksum: z
      .string()
      .max(128)
      .regex(/^[0-9a-fA-F]+$/)
      .optional(),
    checksumAlgorithm: CHECKSUM_ALGORITHMS.optional(),
    verifyCertificates: z.boolean().default(true),
  })
  .strict()
  .refine((data) => (data.checksum === undefined) === (data.checksumAlgorithm === undefined), {
    message: 'checksum and checksumAlgorithm must both be set, or both left unset',
  });

/** PVE's own volume id shape: `<storage>:<rest>` (e.g. `local:iso/debian.iso`,
 * `local-lvm:vm-100-disk-0`) -- the same shape real PVE volids always take. Capped well above any
 * real volid PVE has ever produced; `..` is rejected the same defensive way `filenameSchema` does,
 * even though a colon-delimited volid was never a filesystem path to begin with. */
const VOLID_RE = /^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9/._+-]*$/;
const volidSchema = z
  .string()
  .max(255)
  .regex(VOLID_RE)
  .refine((value) => !value.includes('..'), { message: 'volid must not contain ".."' });

const vmidQuerySchema = z.coerce.number().int().positive();

/** Maps a PVE call failure to the same `502`/`4xx` response shape every guest-action route uses
 * (mirrors `migrateRoutes.ts`'s own `sendPveError`); returns `true` iff it sent a reply. */
function sendPveError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof PveApiError) {
    if (error.status >= 500) {
      reply.code(502).send({ error: 'pve-unreachable' });
    } else {
      reply.code(error.status).send({ error: 'pve-rejected', message: sanitizeMessage(error.message) });
    }
    return true;
  }
  return false;
}

/** Whether `volid`'s own `<storage>:...` prefix matches the storage this route is scoped to --
 * the delete route refuses a volid for a *different* storage rather than silently forwarding it
 * (PVE's own endpoint is itself storage-scoped by path, but this keeps the mismatch an explicit
 * 400 instead of a confusing PVE-side error). */
function volidBelongsToStorage(volid: string, storage: string): boolean {
  return volid.startsWith(`${storage}:`);
}

export function registerStorageRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  // Encapsulated sub-plugin: the `multipart/form-data` content-type parser registered below is
  // scoped to just this context (and so only to the upload route registered inside it), not
  // leaked onto the shared `app` instance the rest of `actionsRoutes` registers routes on.
  app.register(async (instance) => {
    // Fastify has no multipart parser by default -- an unrecognised content-type gets its own
    // automatic 415 before any route handler runs. Registering this one hands the *raw* request
    // stream straight to `request.body` (no `parseAs`, so Fastify never buffers or reads it
    // itself): the handler below pipes that stream straight to PVE, so the uploaded file's bytes
    // are read into this process's memory exactly zero times.
    instance.addContentTypeParser('multipart/form-data', (_req, payload, done) => {
      done(null, payload);
    });

    instance.post(
      '/api/actions/storage/:node/:storage/upload',
      { onRequest: guestActionsRateLimit },
      async (req, reply) => {
        const routeParams = req.params as Record<string, string>;
        const node = nodeNameSchema.safeParse(routeParams.node);
        const storage = storageIdSchema.safeParse(routeParams.storage);
        if (!node.success || !storage.success) {
          reply.code(400).send({ error: 'Invalid node/storage' });
          return;
        }

        const query = req.query as Record<string, string>;
        const content = uploadContentSchema.safeParse(query.content);
        const filename = filenameSchema.safeParse(query.filename);
        if (!content.success || !filename.success) {
          reply.code(400).send({ error: 'Invalid content/filename' });
          return;
        }

        const identity = await resolveIdentity(app, req);
        if (!identity) {
          reply.code(401).send({ error: 'Not authenticated' });
          return;
        }
        if (identity.credentials.type === 'token') {
          reply.code(403).send({ error: 'writes-disabled-in-token-mode' });
          return;
        }

        // Required and size-capped *before* any PVE call (including the permission check below)
        // -- a malformed or oversized request is rejected without ever contacting PVE.
        const contentLengthHeader = req.headers['content-length'];
        if (!contentLengthHeader) {
          reply.code(411).send({ error: 'length-required' });
          return;
        }
        // Strictly digits-only (no sign, no decimal point, no exponent, no leading/trailing
        // whitespace) -- `Number(...)` alone would accept `"5.5"` (finite, non-negative) and
        // forward a fractional byte count to PVE as a `content-length` header.
        if (!/^\d+$/.test(contentLengthHeader) || !Number.isSafeInteger(Number(contentLengthHeader))) {
          reply.code(400).send({ error: 'invalid-content-length' });
          return;
        }
        const contentLength = Number(contentLengthHeader);
        const maxBytes = app.proxionConfig.PROXION_UPLOAD_MAX_BYTES;
        if (contentLength > maxBytes) {
          reply.code(413).send({ error: 'payload-too-large', maxBytes });
          return;
        }

        let allowed: boolean;
        try {
          allowed = await hasStoragePrivilege(identity.client, storage.data, 'Datastore.AllocateTemplate');
        } catch (error) {
          app.log.warn({ err: error }, 'Failed to check Datastore.AllocateTemplate permission for storage upload');
          reply.code(502).send({ error: 'pve-unreachable' });
          return;
        }
        if (!allowed) {
          reply.code(403).send({ error: 'forbidden', missing: 'Datastore.AllocateTemplate' });
          return;
        }

        // Aborts the outgoing PVE request the moment the browser disconnects mid-upload
        // (`req.raw`'s `aborted` event, or a `close` seen before the request finished arriving --
        // `req.raw.complete` is only ever true once the whole body has been received) so a
        // half-sent upload doesn't hang PVE-side, and so this route settles cleanly instead of
        // leaving an unhandled rejection once the response can no longer be written.
        const abortController = new AbortController();
        const abort = () => abortController.abort();
        req.raw.once('aborted', abort);
        req.raw.once('close', () => {
          if (!req.raw.complete) abort();
        });
        // A Node `Readable`'s `error` event throws as an uncaught exception (crashing the process)
        // when nothing is listening for it -- a real risk here, since the request stream this
        // route pipes to PVE (`req.raw`) can itself emit one for the same reason it emits
        // `aborted`/`close` early (e.g. the underlying socket resets mid-upload). The abort wiring
        // above already gets PVE-side cleanup from `aborted`/`close`; this is only the required
        // listener that keeps that same event from taking the whole server down.
        req.raw.on('error', () => {});

        let upid: unknown;
        try {
          upid = await identity.client.uploadStream(
            '/nodes/{node}/storage/{storage}/upload',
            { node: node.data, storage: storage.data },
            {
              headers: { 'content-type': String(req.headers['content-type']) },
              // The route-scoped content-type parser registered above hands the raw incoming
              // request stream straight through as `request.body` (no `parseAs`) -- this is
              // Fastify's `req.raw` itself, a Node `Readable`, never buffered by this process.
              body: req.body as unknown as Readable,
              contentLength,
              signal: abortController.signal,
            },
          );
        } catch (error) {
          if (sendPveError(reply, error)) return;
          app.log.warn({ err: error }, 'Storage upload request failed');
          reply.code(502).send({ error: 'pve-unreachable' });
          return;
        }

        app.log.info(
          {
            username: identity.username,
            node: node.data,
            storage: storage.data,
            content: content.data,
            filename: filename.data,
            upid,
          },
          'Storage upload requested',
        );
        reply.code(202).send({ upid });
      },
    );
  });

  app.post(
    '/api/actions/storage/:node/:storage/download-url',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const routeParams = req.params as Record<string, string>;
      const node = nodeNameSchema.safeParse(routeParams.node);
      const storage = storageIdSchema.safeParse(routeParams.storage);
      if (!node.success || !storage.success) {
        reply.code(400).send({ error: 'Invalid node/storage' });
        return;
      }

      const body = downloadUrlBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        reply.code(400).send({ error: 'Invalid request body' });
        return;
      }

      const identity = await resolveIdentity(app, req);
      if (!identity) {
        reply.code(401).send({ error: 'Not authenticated' });
        return;
      }
      if (identity.credentials.type === 'token') {
        reply.code(403).send({ error: 'writes-disabled-in-token-mode' });
        return;
      }

      let allowed: boolean;
      try {
        allowed = await hasStoragePrivilege(identity.client, storage.data, 'Datastore.AllocateTemplate');
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check Datastore.AllocateTemplate permission for storage download-url');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (!allowed) {
        reply.code(403).send({ error: 'forbidden', missing: 'Datastore.AllocateTemplate' });
        return;
      }

      let upid: string;
      try {
        upid = await identity.client.post('/nodes/{node}/storage/{storage}/download-url', {
          node: node.data,
          storage: storage.data,
          url: body.data.url,
          content: body.data.content,
          filename: body.data.filename,
          ...(body.data.checksum !== undefined ? { checksum: body.data.checksum } : {}),
          ...(body.data.checksumAlgorithm !== undefined
            ? { 'checksum-algorithm': body.data.checksumAlgorithm }
            : {}),
          'verify-certificates': body.data.verifyCertificates,
        });
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Storage download-url request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      app.log.info(
        {
          username: identity.username,
          node: node.data,
          storage: storage.data,
          content: body.data.content,
          filename: body.data.filename,
          upid,
        },
        'Storage download-url requested',
      );
      reply.code(202).send({ upid });
    },
  );

  // Node-scoped (not storage-scoped): no `Datastore.*` privilege check here -- PVE itself enforces
  // `Sys.AccessNetwork` on the node for this endpoint (PVE 8+), surfaced as its own 403 via
  // `sendPveError` below same as any other PVE-side rejection.
  app.get('/api/actions/storage/:node/query-url-metadata', { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const routeParams = req.params as Record<string, string>;
    const node = nodeNameSchema.safeParse(routeParams.node);
    if (!node.success) {
      reply.code(400).send({ error: 'Invalid node' });
      return;
    }

    const query = req.query as Record<string, string>;
    const url = urlSchema.safeParse(query.url);
    if (!url.success) {
      reply.code(400).send({ error: 'Invalid url' });
      return;
    }
    const verifyCertificates = query.verifyCertificates === undefined ? true : query.verifyCertificates !== 'false';

    const identity = await resolveIdentity(app, req);
    if (!identity) {
      reply.code(401).send({ error: 'Not authenticated' });
      return;
    }
    if (identity.credentials.type === 'token') {
      reply.code(403).send({ error: 'writes-disabled-in-token-mode' });
      return;
    }

    let result: unknown;
    try {
      result = await identity.client.get('/nodes/{node}/query-url-metadata', {
        node: node.data,
        url: url.data,
        'verify-certificates': verifyCertificates,
      });
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'query-url-metadata request failed');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    reply.code(200).send(result);
  });

  /**
   * Storage content delete (T32 addendum) -- mirrors PVE's own privilege model for this endpoint:
   * `Datastore.Allocate` on the storage always allows it; failing that, a caller who also passes
   * `?vmid=<n>` and holds both `Datastore.AllocateSpace` on the storage *and* `VM.Backup` on that
   * guest is allowed too (the "delete my own guest's backup" carve-out PVE itself grants backup
   * operators without the full `Datastore.Allocate` privilege). PVE's own refusal for a protected
   * backup or an in-use disk is never second-guessed here -- it's surfaced verbatim via
   * `sendPveError`, same as every other PVE-side rejection.
   */
  app.delete(
    '/api/actions/storage/:node/:storage/content/:volid',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const routeParams = req.params as Record<string, string>;
      const node = nodeNameSchema.safeParse(routeParams.node);
      const storage = storageIdSchema.safeParse(routeParams.storage);
      // `routeParams.volid` is already decoded -- Fastify (via its underlying router) decodes
      // every route param once before handlers ever see it, same as `:node`/`:storage` above.
      // Decoding it *again* here would double-decode a validly-encoded volid (e.g. a literal `%`
      // in a filename, sent as `%2525`) and throws `URIError: URI malformed` on a merely
      // percent-shaped-looking segment (e.g. `%25` on its own) before validation or auth ever
      // runs -- an unauthenticated 500 with an internal error message. Validate the raw param as
      // Fastify delivered it instead.
      const volid = volidSchema.safeParse(routeParams.volid);
      if (!node.success || !storage.success || !volid.success) {
        reply.code(400).send({ error: 'Invalid node/storage/volid' });
        return;
      }
      if (!volidBelongsToStorage(volid.data, storage.data)) {
        reply.code(400).send({ error: 'volid does not belong to this storage' });
        return;
      }

      const query = req.query as { vmid?: string };
      let vmid: number | undefined;
      if (query.vmid !== undefined) {
        const parsedVmid = vmidQuerySchema.safeParse(query.vmid);
        if (!parsedVmid.success) {
          reply.code(400).send({ error: 'Invalid vmid' });
          return;
        }
        vmid = parsedVmid.data;
      }

      const identity = await resolveIdentity(app, req);
      if (!identity) {
        reply.code(401).send({ error: 'Not authenticated' });
        return;
      }
      if (identity.credentials.type === 'token') {
        reply.code(403).send({ error: 'writes-disabled-in-token-mode' });
        return;
      }

      let allowed: boolean;
      try {
        allowed = await hasAllocateOrBackupPrivilege(identity.client, storage.data, vmid);
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check delete permission for storage content');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (!allowed) {
        reply.code(403).send({ error: 'forbidden', missing: 'Datastore.Allocate' });
        return;
      }

      let upid: string;
      try {
        upid = await identity.client.delete('/nodes/{node}/storage/{storage}/content/{volume}', {
          node: node.data,
          storage: storage.data,
          volume: volid.data,
        });
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Storage content delete request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      app.log.info(
        { username: identity.username, node: node.data, storage: storage.data, volid: volid.data, upid },
        'Storage content delete requested',
      );
      reply.code(202).send({ upid });
    },
  );
}

/** The delete route's own permission check (see its doc comment above): `Datastore.Allocate` on
 * the storage always suffices; otherwise, only with a `vmid` given, both `Datastore.AllocateSpace`
 * on the storage and `VM.Backup` on that guest together suffice. */
async function hasAllocateOrBackupPrivilege(client: PveClient, storage: string, vmid: number | undefined): Promise<boolean> {
  if (await hasStoragePrivilege(client, storage, 'Datastore.Allocate')) return true;
  if (vmid === undefined) return false;
  const [hasAllocateSpace, hasBackup] = await Promise.all([
    hasStoragePrivilege(client, storage, 'Datastore.AllocateSpace'),
    hasPrivilege(client, vmid, 'VM.Backup'),
  ]);
  return hasAllocateSpace && hasBackup;
}
