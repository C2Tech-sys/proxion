import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PveApiError } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import {
  MAX_DESCRIPTION_LENGTH,
  formatPveErrorMessage,
  hasNodePrivilege,
  sanitizeDescription,
  sanitizeMessage,
} from './shared.js';

/**
 * Node System tab (T71): edit a node's DNS, time zone, options (description, start-all-on-boot
 * delay, wake-on-LAN MAC, ballooning target) and `/etc/hosts`, and upload or remove its custom TLS
 * certificate. Allow-listed calls this server performs against PVE, registered from `actionsRoutes`
 * (`routes.ts`) so they share its rate limiter, same convention as `registerNodeNetworkRoutes`. The
 * raw `/api/pve/*` proxy stays read-only; the current values (`dns`, `time`, `config`, `hosts`,
 * `certificates/info`) are read through it.
 *
 * Every write needs `Sys.Modify` on `/nodes/{node}`.
 *
 * Notes on what is deliberately NOT here:
 * - ACME fields of `PUT /nodes/{node}/config` (`acme`, `acmedomainN`) and `location` are not
 *   editable through `/options`; the strict body schema refuses them.
 * - `PUT /nodes/{node}/dns` has no `delete` parameter in PVE's API (see the typed endpoint): PVE
 *   rewrites `/etc/resolv.conf` from the `search` + `dnsN` it is handed, so a cleared server is
 *   simply left out of the request.
 *
 * Secrets: the certificate upload carries a private key. It is forwarded to PVE and nothing else --
 * it is never logged, never echoed back, and the PEM PVE returns is dropped from the response.
 */

const SYSTEM_PRIVILEGE = 'Sys.Modify';

const NODE_NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const nodeNameSchema = z.string().min(1).max(63).regex(NODE_NAME_RE);

const DNS_LABEL = '[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const DNS_NAME_RE = new RegExp(`^${DNS_LABEL}(\\.${DNS_LABEL})*$`);
const TIMEZONE_RE = /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/;
const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
const CERT_BEGIN_RE = /-----BEGIN CERTIFICATE-----/;
const KEY_BEGIN_RE = /-----BEGIN (RSA |EC )?PRIVATE KEY-----/;

const MAX_PEM_LENGTH = 65536;
const MAX_HOSTS_LENGTH = 65536;
const MAX_HOSTS_LINE = 1024;

/** An IPv4 or IPv6 literal without a `%zone` suffix. */
function isPlainIp(value: string): boolean {
  return !value.includes('%') && isIP(value) !== 0;
}

/** No NUL byte anywhere, and no line longer than `MAX_HOSTS_LINE`. */
function isValidHostsText(value: string): boolean {
  if (value.includes('\0')) return false;
  return value.split(/\r\n|\r|\n/).every((line) => line.length <= MAX_HOSTS_LINE);
}

const ipSchema = z.string().refine(isPlainIp, { message: 'Invalid IP address' });
const digestSchema = z.string().min(1).max(128);

const dnsBodySchema = z
  .object({
    search: z.string().max(253).regex(DNS_NAME_RE),
    dns1: ipSchema.nullable().optional(),
    dns2: ipSchema.nullable().optional(),
    dns3: ipSchema.nullable().optional(),
  })
  .strict();

const timeBodySchema = z.object({ timezone: z.string().max(64).regex(TIMEZONE_RE) }).strict();

const optionsBodySchema = z
  .object({
    description: z.string().max(MAX_DESCRIPTION_LENGTH).nullable().optional(),
    startallOnbootDelay: z.number().int().min(0).max(300).nullable().optional(),
    wakeonlan: z.string().regex(MAC_RE).nullable().optional(),
    ballooningTarget: z.number().int().min(0).max(100).nullable().optional(),
    digest: digestSchema.optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.description !== undefined ||
      body.startallOnbootDelay !== undefined ||
      body.wakeonlan !== undefined ||
      body.ballooningTarget !== undefined,
    { message: 'At least one option is required' },
  );

const hostsBodySchema = z
  .object({
    data: z.string().min(1).max(MAX_HOSTS_LENGTH).refine(isValidHostsText, { message: 'Invalid hosts text' }),
    digest: digestSchema.optional(),
  })
  .strict();

const certUploadBodySchema = z
  .object({
    certificates: z.string().max(MAX_PEM_LENGTH).regex(CERT_BEGIN_RE),
    key: z.string().max(MAX_PEM_LENGTH).regex(KEY_BEGIN_RE).optional(),
    force: z.boolean().optional(),
    restart: z.boolean().default(true),
  })
  .strict();

const certDeleteBodySchema = z.object({ restart: z.boolean().default(true) }).strict();

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

function badBody(reply: FastifyReply): void {
  reply.code(400).send({ error: 'Invalid request body' });
}

/** The shared session/token/`Sys.Modify` gate. Sends the failure reply itself and returns
 * `undefined`; otherwise returns the caller's identity. */
async function authorize(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply, node: string) {
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
    allowed = await hasNodePrivilege(identity.client, node, SYSTEM_PRIVILEGE);
  } catch (error) {
    if (sendPveError(reply, error)) return undefined;
    app.log.warn({ err: error }, 'Failed to check Sys.Modify permission for node system update');
    reply.code(502).send({ error: 'pve-unreachable' });
    return undefined;
  }
  if (!allowed) {
    reply.code(403).send({ error: 'forbidden', missing: SYSTEM_PRIVILEGE });
    return undefined;
  }
  return identity;
}

/** The fields of a certificate-info row that are safe to return: everything but the `pem`. */
function certificateSummary(info: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof info !== 'object' || info === null) return out;
  const row = info as Record<string, unknown>;
  for (const key of [
    'filename',
    'fingerprint',
    'subject',
    'issuer',
    'notbefore',
    'notafter',
    'san',
    'public-key-type',
    'public-key-bits',
  ]) {
    if (row[key] !== undefined) out[key] = row[key];
  }
  return out;
}

export function registerNodeSystemRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  /** Parses `:node`, answering 400 itself; `undefined` when invalid. */
  function parseNode(req: FastifyRequest, reply: FastifyReply): string | undefined {
    const node = nodeNameSchema.safeParse((req.params as Record<string, string>).node);
    if (!node.success) {
      reply.code(400).send({ error: 'Invalid node' });
      return undefined;
    }
    return node.data;
  }

  /** Runs a PVE call; on failure answers with the right error and returns `{ ok: false }`. */
  async function callPve(
    reply: FastifyReply,
    what: string,
    call: () => Promise<unknown>,
  ): Promise<{ ok: true; value: unknown } | { ok: false }> {
    try {
      return { ok: true, value: await call() };
    } catch (error) {
      if (sendPveError(reply, error)) return { ok: false };
      app.log.warn({ err: error }, `${what} request failed`);
      reply.code(502).send({ error: 'pve-unreachable' });
      return { ok: false };
    }
  }

  app.put('/api/actions/node/:node/system/dns', { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const node = parseNode(req, reply);
    if (node === undefined) return;
    const parsed = dnsBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      badBody(reply);
      return;
    }
    const identity = await authorize(app, req, reply, node);
    if (!identity) return;

    const body = parsed.data;
    const params: Record<string, unknown> = { node, search: body.search };
    for (const key of ['dns1', 'dns2', 'dns3'] as const) {
      const value = body[key];
      if (typeof value === 'string') params[key] = value;
    }
    const result = await callPve(reply, 'Node DNS update', () =>
      identity.client.put('/nodes/{node}/dns', params as never),
    );
    if (!result.ok) return;

    app.log.info({ username: identity.username, node }, 'Node DNS updated');
    reply.code(200).send({ ok: true });
  });

  app.put('/api/actions/node/:node/system/time', { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const node = parseNode(req, reply);
    if (node === undefined) return;
    const parsed = timeBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      badBody(reply);
      return;
    }
    const identity = await authorize(app, req, reply, node);
    if (!identity) return;

    const result = await callPve(reply, 'Node time zone update', () =>
      identity.client.put('/nodes/{node}/time', { node, timezone: parsed.data.timezone }),
    );
    if (!result.ok) return;

    app.log.info({ username: identity.username, node, timezone: parsed.data.timezone }, 'Node time zone updated');
    reply.code(200).send({ ok: true });
  });

  app.put('/api/actions/node/:node/system/options', { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const node = parseNode(req, reply);
    if (node === undefined) return;
    const parsed = optionsBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      badBody(reply);
      return;
    }
    const identity = await authorize(app, req, reply, node);
    if (!identity) return;

    const body = parsed.data;
    const params: Record<string, unknown> = { node };
    const deletions: string[] = [];
    if (body.description !== undefined) {
      const description = body.description === null ? '' : sanitizeDescription(body.description);
      if (description.trim() === '') deletions.push('description');
      else params.description = description;
    }
    const numeric: Array<[string, number | null | undefined]> = [
      ['startall-onboot-delay', body.startallOnbootDelay],
      ['ballooning-target', body.ballooningTarget],
    ];
    for (const [key, value] of numeric) {
      if (value === null) deletions.push(key);
      else if (value !== undefined) params[key] = value;
    }
    if (body.wakeonlan === null) deletions.push('wakeonlan');
    else if (body.wakeonlan !== undefined) params.wakeonlan = body.wakeonlan;
    if (deletions.length > 0) params.delete = deletions.join(',');
    if (body.digest !== undefined) params.digest = body.digest;

    const result = await callPve(reply, 'Node options update', () =>
      identity.client.put('/nodes/{node}/config', params as never),
    );
    if (!result.ok) return;

    app.log.info(
      {
        username: identity.username,
        node,
        fields: Object.keys(params).filter((key) => key !== 'node' && key !== 'digest' && key !== 'delete'),
        deleted: deletions,
      },
      'Node options updated',
    );
    reply.code(200).send({ ok: true });
  });

  app.post('/api/actions/node/:node/system/hosts', { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const node = parseNode(req, reply);
    if (node === undefined) return;
    const parsed = hostsBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      badBody(reply);
      return;
    }
    const identity = await authorize(app, req, reply, node);
    if (!identity) return;

    const params: Record<string, unknown> = { node, data: parsed.data.data };
    if (parsed.data.digest !== undefined) params.digest = parsed.data.digest;
    // PVE replaces the whole of /etc/hosts with `data`.
    const result = await callPve(reply, 'Node hosts update', () =>
      identity.client.post('/nodes/{node}/hosts', params as never),
    );
    if (!result.ok) return;

    app.log.info({ username: identity.username, node }, 'Node hosts file replaced');
    reply.code(200).send({ ok: true });
  });

  app.post('/api/actions/node/:node/system/certificates', { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const node = parseNode(req, reply);
    if (node === undefined) return;
    const parsed = certUploadBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      badBody(reply);
      return;
    }
    const identity = await authorize(app, req, reply, node);
    if (!identity) return;

    const body = parsed.data;
    const params: Record<string, unknown> = { node, certificates: body.certificates, restart: body.restart };
    if (body.key !== undefined) params.key = body.key;
    if (body.force === true) params.force = true;
    const result = await callPve(reply, 'Node custom certificate upload', () =>
      identity.client.post('/nodes/{node}/certificates/custom', params as never),
    );
    if (!result.ok) return;

    // Never log the body: it carries the private key.
    app.log.info(
      { username: identity.username, node, force: body.force === true, restart: body.restart, withKey: body.key !== undefined },
      'Node custom certificate uploaded',
    );
    reply.code(200).send(certificateSummary(result.value));
  });

  app.delete('/api/actions/node/:node/system/certificates', { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const node = parseNode(req, reply);
    if (node === undefined) return;
    const parsed = certDeleteBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      badBody(reply);
      return;
    }
    const identity = await authorize(app, req, reply, node);
    if (!identity) return;

    const result = await callPve(reply, 'Node custom certificate removal', () =>
      identity.client.delete('/nodes/{node}/certificates/custom', { node, restart: parsed.data.restart }),
    );
    if (!result.ok) return;

    app.log.info({ username: identity.username, node, restart: parsed.data.restart }, 'Node custom certificate removed');
    reply.code(200).send({ ok: true });
  });
}
