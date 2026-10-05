import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PveApiError, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import { guestTypeSchema, vmidSchema, hasPrivilege, formatPveErrorMessage, sanitizeMessage } from './shared.js';

/**
 * VM USB, PCI and serial devices (T55): add, edit and remove a `usb<n>`, `hostpci<n>` or
 * `serial<n>` device. Three more allow-listed calls this server performs against PVE, registered
 * from `actionsRoutes` (`routes.ts`) so they share its rate limiter, same convention as
 * `registerNetworkRoutes`. qemu only: a container's `dev<n>` passthrough stays read-only. The raw
 * `/api/pve/*` proxy stays read-only; the property string is composed here from a validated, typed
 * body -- the caller never hands PVE a free-form string. See "Guest actions" in README.md.
 *
 * PVE additionally refuses raw (non-mapped) USB and PCI devices for anyone but root@pam and checks
 * `Mapping.Use` on mapped ones; that is deliberately NOT replicated here -- PVE's error is relayed
 * (via `sendPveError`) as `pve-rejected`.
 */

const DEVICE_PRIVILEGE = 'VM.Config.HWType';

type DeviceKind = 'usb' | 'pci' | 'serial';

/** `usb0`..`usb13`, `hostpci0`..`hostpci15`, `serial0`..`serial3`. Anchored: `usb01`, `USB0`,
 * `usb14`, `hostpci16` and `serial4` all fail. */
const DEVICE_SLOT_RE = /^(usb([0-9]|1[0-3])|hostpci([0-9]|1[0-5])|serial[0-3])$/;

const SLOT_COUNTS: Record<DeviceKind, number> = { usb: 14, pci: 16, serial: 4 };
const SLOT_PREFIX: Record<DeviceKind, string> = { usb: 'usb', pci: 'hostpci', serial: 'serial' };

function slotKind(slot: string): DeviceKind {
  if (slot.startsWith('hostpci')) return 'pci';
  if (slot.startsWith('usb')) return 'usb';
  return 'serial';
}

const USB_VENDOR_RE = /^[0-9a-fA-F]{4}:[0-9a-fA-F]{4}$/;
/** A USB `bus-port` path: `1-2`, `1-2.3`, `2-1.4.1`. */
const USB_PORT_RE = /^\d+-\d+(\.\d+)*$/;
const MAPPING_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
/** `0000:01:00.0`, `01:00.0`, or `01:00` (all functions). */
const PCI_ID_RE = /^([0-9a-f]{4}:)?[0-9a-f]{2}:[0-9a-f]{2}(\.[0-7])?$/;
const MDEV_RE = /^[A-Za-z0-9_.-]{1,64}$/;

// `.strict()` on every member: an unknown key is a 400, same rationale as every other guest-action
// body schema. A flat union (not a discriminated one) because `usb` and `pci` each have several
// `source` shapes under the same `kind`.
const usbCommon = { kind: z.literal('usb'), usb3: z.boolean().optional() };
const pciCommon = {
  kind: z.literal('pci'),
  pcie: z.boolean().optional(),
  rombar: z.boolean().optional(),
  xVga: z.boolean().optional(),
  mdev: z.string().regex(MDEV_RE).optional(),
};

const deviceBodySchema = z.union([
  z.object({ ...usbCommon, source: z.literal('spice') }).strict(),
  z.object({ ...usbCommon, source: z.literal('vendor'), id: z.string().regex(USB_VENDOR_RE) }).strict(),
  z.object({ ...usbCommon, source: z.literal('port'), port: z.string().regex(USB_PORT_RE) }).strict(),
  z.object({ ...usbCommon, source: z.literal('mapping'), mapping: z.string().regex(MAPPING_RE) }).strict(),
  z
    .object({
      ...pciCommon,
      source: z.literal('raw'),
      id: z.string().regex(PCI_ID_RE),
      allFunctions: z.boolean().optional(),
    })
    .strict(),
  z.object({ ...pciCommon, source: z.literal('mapping'), mapping: z.string().regex(MAPPING_RE) }).strict(),
  z.object({ kind: z.literal('serial'), target: z.literal('socket') }).strict(),
]);

export type DeviceBody = z.infer<typeof deviceBodySchema>;

/** The option keys this route models per kind. On an edit, a key=value pair of the existing device
 * whose key is NOT listed here (a PCI `romfile`, `vendor-id`, `legacy-igd`, anything PVE adds
 * later) is carried over unchanged. `host` is modeled because the leading device id of a PCI value
 * may be bare or `host=`-prefixed. */
const MODELED_KEYS: Record<'usb' | 'pci', ReadonlySet<string>> = {
  usb: new Set(['host', 'mapping', 'usb3']),
  pci: new Set(['host', 'mapping', 'pcie', 'rombar', 'x-vga', 'mdev']),
};

/**
 * The key=value pairs of an existing `usb<n>` / `hostpci<n>` value that this route does not model,
 * verbatim and in their original order. A bare leading part (the PCI id written without `host=`)
 * is part of what the body models and is never carried over. Serial has no options.
 */
export function unmodeledDeviceParts(kind: 'usb' | 'pci', raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const modeled = MODELED_KEYS[kind];
  return raw.split(',').filter((part) => {
    if (part === '') return false;
    const eq = part.indexOf('=');
    if (eq === -1) return false;
    return !modeled.has(part.slice(0, eq));
  });
}

/** The PCI id with any `.function` suffix removed (`0000:01:00.0` -> `0000:01:00`). */
function stripPciFunction(id: string): string {
  const dot = id.lastIndexOf('.');
  return dot === -1 ? id : id.slice(0, dot);
}

/**
 * Composes the PVE property string for a validated body, keys in a stable order, unset fields
 * omitted. `extras` (an edit's unmodeled options) are appended unchanged.
 */
export function composeDeviceValue(body: DeviceBody, extras: readonly string[] = []): string {
  const parts: string[] = [];
  if (body.kind === 'serial') {
    return body.target;
  }
  if (body.kind === 'usb') {
    switch (body.source) {
      case 'spice':
        parts.push('host=spice');
        break;
      case 'vendor':
        parts.push(`host=${body.id}`);
        break;
      case 'port':
        parts.push(`host=${body.port}`);
        break;
      case 'mapping':
        parts.push(`mapping=${body.mapping}`);
        break;
    }
    if (body.usb3 === true) parts.push('usb3=1');
  } else {
    if (body.source === 'raw') {
      parts.push(body.allFunctions === true ? stripPciFunction(body.id) : body.id);
    } else {
      parts.push(`mapping=${body.mapping}`);
    }
    if (body.pcie === true) parts.push('pcie=1');
    if (body.rombar === false) parts.push('rombar=0');
    if (body.xVga === true) parts.push('x-vga=1');
    if (body.mdev !== undefined) parts.push(`mdev=${body.mdev}`);
  }
  parts.push(...extras);
  return parts.join(',');
}

interface GuestRouteParams {
  node: string;
  type: 'qemu' | 'lxc';
  vmid: number;
}

function parseGuestParams(rawParams: Record<string, string>): GuestRouteParams | undefined {
  const node = rawParams.node;
  const type = guestTypeSchema.safeParse(rawParams.type);
  const vmid = vmidSchema.safeParse(rawParams.vmid);
  if (!node || !type.success || !vmid.success) return undefined;
  return { node, type: type.data, vmid: vmid.data };
}

/** Same `502`/`4xx` mapping every guest-action route uses; `true` iff it sent a reply. */
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

async function fetchQemuConfig(client: PveClient, node: string, vmid: number): Promise<Record<string, unknown>> {
  const config: unknown = await client.get('/nodes/{node}/qemu/{vmid}/config', { node, vmid });
  return (config ?? {}) as Record<string, unknown>;
}

async function callConfigUpdate(
  client: PveClient,
  node: string,
  vmid: number,
  config: Record<string, string>,
): Promise<void> {
  await client.put('/nodes/{node}/qemu/{vmid}/config', { node, vmid, ...config } as never);
}

interface PendingRow {
  key: string;
  pending?: unknown;
  delete?: unknown;
}

/** `[slot]` when PVE is holding it back until the guest restarts, else `[]`. A failure to read the
 * pending list never fails the (already applied) change -- it just reports none. */
async function pendingFor(
  app: FastifyInstance,
  client: PveClient,
  params: GuestRouteParams,
  slot: string,
): Promise<string[]> {
  try {
    const rows: unknown = await client.get('/nodes/{node}/qemu/{vmid}/pending', {
      node: params.node,
      vmid: params.vmid,
    });
    const held = (Array.isArray(rows) ? (rows as PendingRow[]) : []).some(
      (row) => row.key === slot && (row.pending !== undefined || (row.delete !== undefined && Boolean(row.delete))),
    );
    return held ? [slot] : [];
  } catch (error) {
    app.log.warn({ err: error }, 'Failed to read pending config after guest device update');
    return [];
  }
}

/** The shared session/token/privilege gate. Sends the failure reply itself and returns
 * `undefined`; otherwise returns the caller's identity. */
async function authorize(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  vmid: number,
  privilege: string | undefined,
) {
  const identity = await resolveIdentity(app, req);
  if (!identity) {
    reply.code(401).send({ error: 'Not authenticated' });
    return undefined;
  }
  if (identity.credentials.type === 'token') {
    reply.code(403).send({ error: 'writes-disabled-in-token-mode' });
    return undefined;
  }
  if (privilege !== undefined) {
    let allowed: boolean;
    try {
      allowed = await hasPrivilege(identity.client, vmid, privilege);
    } catch (error) {
      app.log.warn({ err: error }, 'Failed to check permissions for guest device update');
      reply.code(502).send({ error: 'pve-unreachable' });
      return undefined;
    }
    if (!allowed) {
      reply.code(403).send({ error: 'forbidden', missing: privilege });
      return undefined;
    }
  }
  return identity;
}

function notApplicable(reply: FastifyReply): void {
  reply.code(400).send({
    error: 'not-applicable',
    message: 'USB, PCI and serial devices can only be edited on virtual machines.',
  });
}

export function registerDeviceRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  app.put(
    '/api/actions/guest/:node/:type/:vmid/devices/:slot',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const rawParams = req.params as Record<string, string>;
      const params = parseGuestParams(rawParams);
      const slot = rawParams.slot ?? '';
      if (!params || !DEVICE_SLOT_RE.test(slot)) {
        reply.code(400).send({ error: 'Invalid node/type/vmid/slot' });
        return;
      }
      if (params.type !== 'qemu') {
        notApplicable(reply);
        return;
      }

      const parsed = deviceBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400).send({ error: 'Invalid request body' });
        return;
      }
      const body = parsed.data;
      if (body.kind !== slotKind(slot)) {
        reply.code(400).send({
          error: 'slot-kind-mismatch',
          message: `${slot} cannot hold a ${body.kind} device`,
        });
        return;
      }

      const identity = await authorize(app, req, reply, params.vmid, DEVICE_PRIVILEGE);
      if (!identity) return;
      const client = identity.client;

      // The current config decides what an edit carries over (options this route does not model).
      let extras: string[] = [];
      if (body.kind !== 'serial') {
        let current: Record<string, unknown>;
        try {
          current = await fetchQemuConfig(client, params.node, params.vmid);
        } catch (error) {
          if (sendPveError(reply, error)) return;
          app.log.warn({ err: error }, 'Failed to read current config for guest device update');
          reply.code(502).send({ error: 'pve-unreachable' });
          return;
        }
        extras = unmodeledDeviceParts(body.kind, current[slot]);
      }
      const value = composeDeviceValue(body, extras);

      try {
        await callConfigUpdate(client, params.node, params.vmid, { [slot]: value });
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Guest device update request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      const pending = await pendingFor(app, client, params, slot);
      // One line per update; the slot only, never the device identifier.
      app.log.info(
        { username: identity.username, node: params.node, vmid: params.vmid, slot, pending },
        'Guest device saved',
      );
      reply.code(200).send({ ok: true, changed: [slot], pending });
    },
  );

  app.delete(
    '/api/actions/guest/:node/:type/:vmid/devices/:slot',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const rawParams = req.params as Record<string, string>;
      const params = parseGuestParams(rawParams);
      const slot = rawParams.slot ?? '';
      if (!params || !DEVICE_SLOT_RE.test(slot)) {
        reply.code(400).send({ error: 'Invalid node/type/vmid/slot' });
        return;
      }
      if (params.type !== 'qemu') {
        notApplicable(reply);
        return;
      }

      const identity = await authorize(app, req, reply, params.vmid, DEVICE_PRIVILEGE);
      if (!identity) return;
      const client = identity.client;

      try {
        const current = await fetchQemuConfig(client, params.node, params.vmid);
        if (current[slot] === undefined || current[slot] === null) {
          reply.code(404).send({ error: 'not-found', message: `${slot} does not exist on this guest` });
          return;
        }
        await callConfigUpdate(client, params.node, params.vmid, { delete: slot });
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Guest device removal failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      const pending = await pendingFor(app, client, params, slot);
      app.log.info(
        { username: identity.username, node: params.node, vmid: params.vmid, slot, pending },
        'Guest device removed',
      );
      reply.code(200).send({ ok: true, pending });
    },
  );

  app.get(
    '/api/actions/guest/:node/:type/:vmid/devices/next-slot',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = parseGuestParams(req.params as Record<string, string>);
      if (!params) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
        return;
      }
      if (params.type !== 'qemu') {
        notApplicable(reply);
        return;
      }
      const kind = z.enum(['usb', 'pci', 'serial']).safeParse((req.query as Record<string, unknown>).kind);
      if (!kind.success) {
        reply.code(400).send({ error: 'Invalid kind' });
        return;
      }
      const identity = await authorize(app, req, reply, params.vmid, undefined);
      if (!identity) return;

      let current: Record<string, unknown>;
      try {
        current = await fetchQemuConfig(identity.client, params.node, params.vmid);
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Failed to read current config for next device slot');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      for (let n = 0; n < SLOT_COUNTS[kind.data]; n++) {
        const slot = `${SLOT_PREFIX[kind.data]}${n}`;
        if (current[slot] === undefined) {
          reply.code(200).send({ slot });
          return;
        }
      }
      reply.code(409).send({
        error: 'no-free-slot',
        message: `All ${SLOT_COUNTS[kind.data]} ${kind.data} device slots are in use`,
      });
    },
  );
}
