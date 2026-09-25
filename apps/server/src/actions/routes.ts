import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PveApiError, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import { registerSnapshotRoutes } from './snapshotRoutes.js';
import {
  guestTypeSchema,
  vmidSchema,
  MAX_DESCRIPTION_LENGTH,
  sanitizeDescription,
  sanitizeMessage,
  rateLimitKey,
  hasPrivilege,
} from './shared.js';

const actionSchema = z.enum(['start', 'shutdown', 'stop', 'reboot', 'reset', 'suspend', 'resume']);

/** These three actions only exist for `qemu` guests -- PVE has no lxc equivalent for reset, and
 * (per this ticket) lxc suspend/resume are out of scope even though PVE exposes the endpoints. */
const QEMU_ONLY_ACTIONS = new Set(['reset', 'suspend', 'resume']);

// `.strict()`: an unknown key (most notably `skiplock`, which this route must never forward to
// PVE) fails validation with a 400 instead of being silently ignored or passed through.
const bodySchema = z
  .object({
    timeout: z.number().int().min(1).max(3600).optional(),
    forceStop: z.boolean().optional(),
  })
  .strict();

/** PVE's max length for qemu's `name` field / lxc's `hostname` field -- both are validated as a
 * dns-name (see `isValidDnsName`), but the two have different total-length caps. */
const MAX_VM_NAME_LENGTH = 253;
const MAX_HOSTNAME_LENGTH = 255;

// `.strict()`, same reasoning as `bodySchema` above. `description`'s length is capped here
// (before `sanitizeDescription` normalises/strips it) rather than after: normalising line endings
// and stripping control characters only ever removes characters, so an input that already fits
// under the cap is guaranteed to still fit once sanitised, and this lets zod's own `.max()`
// produce the same generic "Invalid request body" 400 the rest of this schema does. `name`'s
// dns-name format isn't validated here -- it depends on the guest `type` path param, which this
// object doesn't have access to -- see `isValidDnsName`, called from the route handler once `type`
// is known. The refine below requires at least one of `name`/`description`: an empty body has
// nothing to change and is rejected the same way an all-unknown-keys body is.
const configBodySchema = z
  .object({
    name: z.string().optional(),
    description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
  })
  .strict()
  .refine((data) => data.name !== undefined || data.description !== undefined, {
    message: 'At least one of name or description is required',
  });

/** One label of a dns-name: `[A-Za-z0-9]`, optionally with inner `-` (never leading/trailing),
 * 1-63 characters. */
const DNS_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * PVE's `dns-name` format, used for qemu's `name` and lxc's `hostname`: one or more
 * dot-separated labels (see `DNS_LABEL_RE`), the whole string capped at `maxTotalLength`
 * (253 for qemu's `name`, 255 for lxc's `hostname` -- `MAX_VM_NAME_LENGTH`/`MAX_HOSTNAME_LENGTH`).
 *
 * KEEP THIS IDENTICAL to `isValidDnsName` in `apps/web/src/lib/guestName.ts` -- that's the same
 * rule, enforced client-side for inline validation before the request is ever sent; this copy is
 * what actually protects PVE, since the client-side one is only a UX nicety.
 */
function isValidDnsName(value: string, maxTotalLength: number): boolean {
  if (value.length === 0 || value.length > maxTotalLength) return false;
  return value.split('.').every((label) => DNS_LABEL_RE.test(label));
}

/** Normalises `description` to `\n` line endings and strips control characters other than
 * `\n`/`\t` before it's sent to PVE. Never lengthens the string, so validating `configBodySchema`'s
 * `description.max()` against the *un*-sanitised input is still a safe upper bound. Now defined
 * in `shared.ts` (re-imported above) so `snapshotRoutes.ts` can use it too without a circular
 * import between the two route files. */

async function hasPowerMgmt(client: PveClient, vmid: number): Promise<boolean> {
  return hasPrivilege(client, vmid, 'VM.PowerMgmt');
}

/** Same shape as `hasPowerMgmt`, checking `VM.Config.Options` instead -- the privilege that gates
 * the rename/notes route below. A caller with `VM.PowerMgmt` but not `VM.Config.Options` (or vice
 * versa) is a different privilege and must still be refused. */
async function hasConfigOptions(client: PveClient, vmid: number): Promise<boolean> {
  return hasPrivilege(client, vmid, 'VM.Config.Options');
}

type ConfigChange = 'name' | 'description';

/**
 * Dispatches the rename/notes update to PVE via one explicit, generated-endpoint-checked
 * `client.put()` call per guest type -- same rationale as `callAction` above. qemu's field is
 * `name`; lxc has no `name` config key, so the same rename goes out as `hostname` instead (see
 * `packages/pve-api/src/generated/endpoints.ts`). PVE's config PUT is synchronous (no task/UPID).
 */
async function callConfigUpdate(
  client: PveClient,
  type: 'qemu' | 'lxc',
  { node, vmid, name, description }: { node: string; vmid: number; name?: string; description?: string },
): Promise<void> {
  if (type === 'qemu') {
    await client.put('/nodes/{node}/qemu/{vmid}/config', {
      node,
      vmid,
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
    });
  } else {
    await client.put('/nodes/{node}/lxc/{vmid}/config', {
      node,
      vmid,
      ...(name !== undefined ? { hostname: name } : {}),
      ...(description !== undefined ? { description } : {}),
    });
  }
}

interface ActionParams {
  node: string;
  vmid: number;
  forceStop?: boolean | undefined;
  timeout?: number | undefined;
}

/**
 * Dispatches to PVE via one explicit `client.post()` call per (type, action) pair, rather than
 * building `/nodes/{node}/{type}/{vmid}/status/{action}` from the validated-but-still-external
 * `action` value -- every call this makes is checked at compile time against the generated
 * endpoint table (`packages/pve-api`), so a typo here is a build failure, not a runtime one, and
 * `action` never becomes part of a dynamically-built request path.
 */
async function callAction(
  client: PveClient,
  type: 'qemu' | 'lxc',
  action: z.infer<typeof actionSchema>,
  { node, vmid, forceStop, timeout }: ActionParams,
): Promise<string> {
  const key = `${type}:${action}` as const;
  switch (key) {
    case 'qemu:start':
      return client.post('/nodes/{node}/qemu/{vmid}/status/start', { node, vmid });
    case 'qemu:shutdown':
      return client.post('/nodes/{node}/qemu/{vmid}/status/shutdown', {
        node,
        vmid,
        ...(forceStop !== undefined ? { forceStop } : {}),
        ...(timeout !== undefined ? { timeout } : {}),
      });
    case 'qemu:stop':
      return client.post('/nodes/{node}/qemu/{vmid}/status/stop', { node, vmid });
    case 'qemu:reboot':
      return client.post('/nodes/{node}/qemu/{vmid}/status/reboot', {
        node,
        vmid,
        ...(timeout !== undefined ? { timeout } : {}),
      });
    case 'qemu:reset':
      return client.post('/nodes/{node}/qemu/{vmid}/status/reset', { node, vmid });
    case 'qemu:suspend':
      return client.post('/nodes/{node}/qemu/{vmid}/status/suspend', { node, vmid });
    case 'qemu:resume':
      return client.post('/nodes/{node}/qemu/{vmid}/status/resume', { node, vmid });
    case 'lxc:start':
      return client.post('/nodes/{node}/lxc/{vmid}/status/start', { node, vmid });
    case 'lxc:shutdown':
      return client.post('/nodes/{node}/lxc/{vmid}/status/shutdown', {
        node,
        vmid,
        ...(forceStop !== undefined ? { forceStop } : {}),
        ...(timeout !== undefined ? { timeout } : {}),
      });
    case 'lxc:stop':
      return client.post('/nodes/{node}/lxc/{vmid}/status/stop', { node, vmid });
    case 'lxc:reboot':
      return client.post('/nodes/{node}/lxc/{vmid}/status/reboot', {
        node,
        vmid,
        ...(timeout !== undefined ? { timeout } : {}),
      });
    default:
      // Unreachable in practice: the route handler already rejects `reset`/`suspend`/`resume`
      // for `lxc` (`QEMU_ONLY_ACTIONS`) before this is ever called.
      throw new Error(`Unsupported action "${action}" for guest type "${type}"`);
  }
}

/**
 * Guest power actions -- the one allow-listed way this server performs a write against PVE. See
 * "Guest actions" in README.md for the full contract (permission model, error mapping, rate
 * limit). The raw `/api/pve/*` proxy (`proxy/pveProxy.ts`) stays entirely read-only; every write
 * this app makes goes through this route instead, one explicit, validated call at a time.
 */
export default async function actionsRoutes(app: FastifyInstance): Promise<void> {
  // One rate limiter, created once and attached to both routes below as an explicit `onRequest`
  // hook (rather than each route getting its own `config.rateLimit`) so a caller's power actions
  // and their config (rename/notes) requests draw from the *same* 30/minute bucket instead of
  // each route silently getting its own separate 30/minute allowance -- `@fastify/rate-limit`
  // gives every `config.rateLimit`-configured route its own independent counter store even when
  // the settings are identical, so sharing the bucket means sharing this one hook instance.
  const guestActionsRateLimit = app.rateLimit({
    max: 30,
    timeWindow: '1 minute',
    keyGenerator: rateLimitKey,
  });

  app.post(
    '/api/actions/guest/:node/:type/:vmid/:action',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = req.params as Record<string, string>;
      const node = params.node;
      const type = guestTypeSchema.safeParse(params.type);
      const vmid = vmidSchema.safeParse(params.vmid);
      const action = actionSchema.safeParse(params.action);

      if (!node || !type.success || !vmid.success || !action.success) {
        reply.code(400).send({ error: 'Invalid node/type/vmid/action' });
        return;
      }
      if (type.data === 'lxc' && QEMU_ONLY_ACTIONS.has(action.data)) {
        reply.code(400).send({ error: `Action "${action.data}" is only valid for qemu guests` });
        return;
      }

      const body = bodySchema.safeParse(req.body ?? {});
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
        allowed = await hasPowerMgmt(identity.client, vmid.data);
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check VM.PowerMgmt permission for guest action');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (!allowed) {
        reply.code(403).send({ error: 'forbidden', missing: 'VM.PowerMgmt' });
        return;
      }

      let upid: string;
      try {
        upid = await callAction(identity.client, type.data, action.data, {
          node,
          vmid: vmid.data,
          forceStop: body.data.forceStop,
          timeout: body.data.timeout,
        });
      } catch (error) {
        if (error instanceof PveApiError) {
          if (error.status >= 500) {
            reply.code(502).send({ error: 'pve-unreachable' });
            return;
          }
          reply.code(error.status).send({ error: 'pve-rejected', message: sanitizeMessage(error.message) });
          return;
        }
        app.log.warn({ err: error }, 'Guest action request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      // One line per action; never the ticket/token, only the resolved identity's safe-to-log
      // username (see `resolveIdentity`).
      app.log.info(
        { username: identity.username, node, type: type.data, vmid: vmid.data, action: action.data, upid },
        'Guest action executed',
      );
      reply.code(202).send({ upid });
    },
  );

  /**
   * Guest rename/notes -- the other allow-listed write this server performs against PVE, next to
   * the power actions above. See "Guest actions" in README.md for the full contract. PVE's config
   * PUT is synchronous (no task), so this responds `200 { ok, changed }` directly instead of a
   * UPID.
   */
  app.patch(
    '/api/actions/guest/:node/:type/:vmid/config',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = req.params as Record<string, string>;
      const node = params.node;
      const type = guestTypeSchema.safeParse(params.type);
      const vmid = vmidSchema.safeParse(params.vmid);

      if (!node || !type.success || !vmid.success) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
        return;
      }

      const body = configBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        reply.code(400).send({ error: 'Invalid request body' });
        return;
      }

      if (body.data.name !== undefined) {
        const maxLength = type.data === 'lxc' ? MAX_HOSTNAME_LENGTH : MAX_VM_NAME_LENGTH;
        if (!isValidDnsName(body.data.name, maxLength)) {
          reply.code(400).send({
            error: 'invalid-name',
            message:
              'Name must be a valid dns-name: dot-separated labels of letters, digits and inner hyphens, 1-63 characters each.',
          });
          return;
        }
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
        allowed = await hasConfigOptions(identity.client, vmid.data);
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check VM.Config.Options permission for guest config update');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (!allowed) {
        reply.code(403).send({ error: 'forbidden', missing: 'VM.Config.Options' });
        return;
      }

      const description =
        body.data.description !== undefined ? sanitizeDescription(body.data.description) : undefined;
      const changed: ConfigChange[] = [];
      if (body.data.name !== undefined) changed.push('name');
      if (description !== undefined) changed.push('description');

      try {
        await callConfigUpdate(identity.client, type.data, {
          node,
          vmid: vmid.data,
          ...(body.data.name !== undefined ? { name: body.data.name } : {}),
          ...(description !== undefined ? { description } : {}),
        });
      } catch (error) {
        if (error instanceof PveApiError) {
          if (error.status >= 500) {
            reply.code(502).send({ error: 'pve-unreachable' });
            return;
          }
          reply.code(error.status).send({ error: 'pve-rejected', message: sanitizeMessage(error.message) });
          return;
        }
        app.log.warn({ err: error }, 'Guest config update request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      // One line per update; the changed *keys* only -- never the name or description text
      // itself (the description in particular may hold anything the guest owner wrote).
      app.log.info(
        { username: identity.username, node, type: type.data, vmid: vmid.data, changed },
        'Guest config updated',
      );
      reply.code(200).send({ ok: true, changed });
    },
  );

  // Snapshot create/delete/rollback (`snapshotRoutes.ts`) share this same 30/minute bucket --
  // passed the already-built limiter rather than each getting its own via `app.rateLimit()`, for
  // the identical reason the power-action and config routes above share it.
  registerSnapshotRoutes(app, guestActionsRateLimit);
}
