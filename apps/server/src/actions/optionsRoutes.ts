import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PveApiError, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import { guestTypeSchema, vmidSchema, hasPrivilege, formatPveErrorMessage, sanitizeMessage } from './shared.js';

/**
 * Guest "Options" edits (T53): the fields of PVE's Options panel for qemu and lxc guests.
 * One more allow-listed write this server performs against PVE, registered from `actionsRoutes`
 * (`routes.ts`) so it shares the guest-actions rate limiter, same convention as
 * `registerHardwareRoutes`/`registerNetworkRoutes`. The raw `/api/pve/*` proxy stays read-only;
 * every option that can be changed is named here, validated, and composed into its PVE property
 * string explicitly. See "Guest actions" in README.md for the contract.
 */

/** One label of a dns-name: `[A-Za-z0-9]`, optionally with inner `-` (never leading/trailing). */
const DNS_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** PVE's dns-name shape: dot-separated labels, the whole string capped at `maxLength`. */
function isValidDnsName(value: string, maxLength: number): boolean {
  if (value.length === 0 || value.length > maxLength) return false;
  return value.split('.').every((label) => DNS_LABEL_RE.test(label));
}

/** `name`/`hostname` are capped at 63 characters in total (this route's contract). */
const MAX_NAME_LENGTH = 63;
/** A search domain is a regular DNS name, so the DNS limit applies. */
const MAX_SEARCHDOMAIN_LENGTH = 253;

const guestNameSchema = z.string().refine((v) => isValidDnsName(v, MAX_NAME_LENGTH), {
  message: 'Invalid DNS name',
});

const searchdomainSchema = z.string().refine((v) => isValidDnsName(v, MAX_SEARCHDOMAIN_LENGTH), {
  message: 'Invalid DNS name',
});

const TAG_RE = /^[a-z0-9_][a-z0-9_\-+.]*$/i;
const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 64;

const OSTYPES = [
  'other',
  'wxp',
  'w2k',
  'w2k3',
  'w2k8',
  'wvista',
  'win7',
  'win8',
  'win10',
  'win11',
  'l24',
  'l26',
  'solaris',
] as const;

const HOTPLUG_ITEMS = ['network', 'disk', 'cpu', 'memory', 'usb', 'cloudinit'] as const;

const MAX_NAMESERVERS = 3;

/** An IPv4/IPv6 literal. A zone id (`fe80::1%eth0`) is not an address PVE accepts as a nameserver. */
const ipSchema = z.string().refine((v) => !v.includes('%') && isIP(v) !== 0, { message: 'Invalid IP address' });

const startupSchema = z
  .object({
    order: z.number().int().min(0).optional(),
    up: z.number().int().min(0).optional(),
    down: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((v) => v.order !== undefined || v.up !== undefined || v.down !== undefined, {
    message: 'startup needs at least one of order/up/down (send null to clear it)',
  });

const agentSchema = z
  .object({
    enabled: z.boolean(),
    fstrimClonedDisks: z.boolean().optional(),
  })
  .strict();

// `.strict()`: an unknown key is a 400, same rationale as every other guest-action body schema.
// Every key is optional, at least one is required. Per-type field guards (qemu-only vs lxc-only)
// live in the handler, where the guest `type` is known.
const optionsBodySchema = z
  .object({
    name: guestNameSchema.optional(),
    hostname: guestNameSchema.optional(),
    onboot: z.boolean().optional(),
    startup: startupSchema.nullable().optional(),
    ostype: z.enum(OSTYPES).optional(),
    protection: z.boolean().optional(),
    tags: z.array(z.string().max(MAX_TAG_LENGTH).regex(TAG_RE)).max(MAX_TAGS).optional(),
    agent: agentSchema.optional(),
    localtime: z.boolean().nullable().optional(),
    tablet: z.boolean().optional(),
    acpi: z.boolean().optional(),
    kvm: z.boolean().optional(),
    hotplug: z.array(z.enum(HOTPLUG_ITEMS)).max(HOTPLUG_ITEMS.length).optional(),
    nameserver: z.array(ipSchema).max(MAX_NAMESERVERS).optional(),
    searchdomain: searchdomainSchema.nullable().optional(),
  })
  .strict()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'At least one option is required',
  });

type OptionsBody = z.infer<typeof optionsBodySchema>;
type OptionKey = keyof OptionsBody;

/** The order keys are processed in: privilege checks (first missing is reported), composition and
 * the `changed` list. */
const QEMU_KEYS = [
  'name',
  'onboot',
  'startup',
  'ostype',
  'protection',
  'tags',
  'agent',
  'localtime',
  'tablet',
  'acpi',
  'kvm',
  'hotplug',
] as const satisfies readonly OptionKey[];
const LXC_KEYS = [
  'hostname',
  'onboot',
  'startup',
  'protection',
  'tags',
  'nameserver',
  'searchdomain',
] as const satisfies readonly OptionKey[];

type OptionsPrivilege = 'VM.Config.Options' | 'VM.Config.HWType' | 'VM.Config.Network';

const QEMU_PRIVILEGE: Record<(typeof QEMU_KEYS)[number], OptionsPrivilege> = {
  name: 'VM.Config.Options',
  onboot: 'VM.Config.Options',
  startup: 'VM.Config.Options',
  ostype: 'VM.Config.Options',
  protection: 'VM.Config.Options',
  tags: 'VM.Config.Options',
  agent: 'VM.Config.Options',
  localtime: 'VM.Config.Options',
  tablet: 'VM.Config.HWType',
  acpi: 'VM.Config.HWType',
  kvm: 'VM.Config.HWType',
  hotplug: 'VM.Config.HWType',
};
// pve-container groups the hostname and DNS settings under the Network privilege.
const LXC_PRIVILEGE: Record<(typeof LXC_KEYS)[number], OptionsPrivilege> = {
  hostname: 'VM.Config.Network',
  onboot: 'VM.Config.Options',
  startup: 'VM.Config.Options',
  protection: 'VM.Config.Options',
  tags: 'VM.Config.Options',
  nameserver: 'VM.Config.Network',
  searchdomain: 'VM.Config.Network',
};

interface GuestRouteParams {
  node: string;
  type: 'qemu' | 'lxc';
  vmid: number;
}

/** Parses/validates the common `:node/:type/:vmid` triple (kept local, same rationale as
 * `hardwareRoutes.ts`'s own `parseGuestParams`). */
function parseGuestParams(rawParams: Record<string, string>): GuestRouteParams | undefined {
  const node = rawParams.node;
  const type = guestTypeSchema.safeParse(rawParams.type);
  const vmid = vmidSchema.safeParse(rawParams.vmid);
  if (!node || !type.success || !vmid.success) return undefined;
  return { node, type: type.data, vmid: vmid.data };
}

/** Maps a PVE call failure to the same `502`/`4xx` response shape every guest-action route uses
 * (incl. PVE's per-field `errors` map via `formatPveErrorMessage`); `true` iff it sent a reply. */
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

const flag = (value: boolean): number => (value ? 1 : 0);

/** The sub-keys of a stored `agent` property string that this route does not model (`type`,
 * `freeze-fs-on-backup`, ...), so an edit keeps them instead of silently dropping them. The
 * modeled `enabled`/`fstrim_cloned_disks` (and the legacy bare leading `1`/`0`) are skipped. */
function unmodeledAgentOptions(current: unknown): string[] {
  if (typeof current !== 'string') return [];
  const kept: string[] = [];
  for (const part of current.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '' || /^[01]$/.test(trimmed)) continue;
    const key = trimmed.split('=')[0]!;
    if (key === 'enabled' || key === 'fstrim_cloned_disks') continue;
    kept.push(trimmed);
  }
  return kept;
}

function composeStartup(startup: { order?: number | undefined; up?: number | undefined; down?: number | undefined }) {
  const parts: string[] = [];
  if (startup.order !== undefined) parts.push(`order=${startup.order}`);
  if (startup.up !== undefined) parts.push(`up=${startup.up}`);
  if (startup.down !== undefined) parts.push(`down=${startup.down}`);
  return parts.join(',');
}

interface ComposedOptions {
  /** PVE config parameters to set. */
  put: Record<string, string | number>;
  /** PVE config keys to clear (sent as one comma-joined `delete`). */
  del: string[];
  /** Every PVE key this request touches, in processing order. */
  changed: string[];
}

/** Builds the PVE parameters for this request. `currentAgent` is the guest's stored `agent`
 * property string (qemu only; only read when the request carries `agent`). */
function compose(type: 'qemu' | 'lxc', body: OptionsBody, currentAgent: unknown): ComposedOptions {
  const out: ComposedOptions = { put: {}, del: [], changed: [] };
  const set = (key: string, value: string | number) => {
    out.put[key] = value;
    out.changed.push(key);
  };
  const clear = (key: string) => {
    out.del.push(key);
    out.changed.push(key);
  };

  const keys: readonly OptionKey[] = type === 'qemu' ? QEMU_KEYS : LXC_KEYS;
  for (const key of keys) {
    switch (key) {
      case 'name':
        if (body.name !== undefined) set('name', body.name);
        break;
      case 'hostname':
        if (body.hostname !== undefined) set('hostname', body.hostname);
        break;
      case 'onboot':
      case 'protection':
      case 'tablet':
      case 'acpi':
      case 'kvm': {
        const value = body[key];
        if (value !== undefined) set(key, flag(value));
        break;
      }
      case 'startup':
        if (body.startup === null) clear('startup');
        else if (body.startup !== undefined) set('startup', composeStartup(body.startup));
        break;
      case 'ostype':
        if (body.ostype !== undefined) set('ostype', body.ostype);
        break;
      case 'tags':
        if (body.tags !== undefined) {
          if (body.tags.length === 0) clear('tags');
          else set('tags', body.tags.join(';'));
        }
        break;
      case 'agent':
        if (body.agent !== undefined) {
          const parts = [`enabled=${flag(body.agent.enabled)}`];
          if (body.agent.fstrimClonedDisks === true) parts.push('fstrim_cloned_disks=1');
          parts.push(...unmodeledAgentOptions(currentAgent));
          set('agent', parts.join(','));
        }
        break;
      case 'localtime':
        if (body.localtime === null) clear('localtime');
        else if (body.localtime !== undefined) set('localtime', flag(body.localtime));
        break;
      case 'hotplug':
        if (body.hotplug !== undefined) {
          set('hotplug', body.hotplug.length === 0 ? '0' : body.hotplug.join(','));
        }
        break;
      case 'nameserver':
        if (body.nameserver !== undefined) {
          if (body.nameserver.length === 0) clear('nameserver');
          else set('nameserver', body.nameserver.join(' '));
        }
        break;
      case 'searchdomain':
        if (body.searchdomain === null) clear('searchdomain');
        else if (body.searchdomain !== undefined) set('searchdomain', body.searchdomain);
        break;
    }
  }
  return out;
}

/** PUT .../config -- one explicit, generated-endpoint-checked call per guest type. The params are
 * built dynamically (several optional keys plus `delete`), hence the cast. */
async function callConfigUpdate(
  client: PveClient,
  type: 'qemu' | 'lxc',
  node: string,
  vmid: number,
  config: Record<string, string | number>,
): Promise<void> {
  if (type === 'qemu') {
    await client.put('/nodes/{node}/qemu/{vmid}/config', { node, vmid, ...config } as never);
  } else {
    await client.put('/nodes/{node}/lxc/{vmid}/config', { node, vmid, ...config } as never);
  }
}

interface PendingRow {
  key: string;
  pending?: unknown;
  delete?: unknown;
}

async function fetchPending(
  client: PveClient,
  type: 'qemu' | 'lxc',
  node: string,
  vmid: number,
): Promise<PendingRow[]> {
  const rows: unknown =
    type === 'qemu'
      ? await client.get('/nodes/{node}/qemu/{vmid}/pending', { node, vmid })
      : await client.get('/nodes/{node}/lxc/{vmid}/pending', { node, vmid });
  return Array.isArray(rows) ? (rows as PendingRow[]) : [];
}

async function fetchQemuAgent(client: PveClient, node: string, vmid: number): Promise<unknown> {
  const config = (await client.get('/nodes/{node}/qemu/{vmid}/config', { node, vmid })) as Record<string, unknown>;
  return config.agent;
}

export function registerOptionsRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  app.patch(
    '/api/actions/guest/:node/:type/:vmid/options',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = parseGuestParams(req.params as Record<string, string>);
      if (!params) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
        return;
      }

      const body = optionsBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        reply.code(400).send({ error: 'Invalid request body' });
        return;
      }

      const typeKeys: readonly OptionKey[] = params.type === 'qemu' ? QEMU_KEYS : LXC_KEYS;
      const wrongFields = (Object.keys(body.data) as OptionKey[]).filter(
        (field) => body.data[field] !== undefined && !typeKeys.includes(field),
      );
      if (wrongFields.length > 0) {
        reply.code(400).send({
          error: 'invalid-field-for-type',
          message: `${wrongFields.join(', ')} ${wrongFields.length === 1 ? 'is' : 'are'} not valid for a ${params.type} guest.`,
        });
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
      const client = identity.client;

      // Every key present is checked, in processing order; the first missing privilege is reported.
      const privilegeOf = (key: OptionKey): OptionsPrivilege =>
        params.type === 'qemu'
          ? QEMU_PRIVILEGE[key as keyof typeof QEMU_PRIVILEGE]
          : LXC_PRIVILEGE[key as keyof typeof LXC_PRIVILEGE];
      const presentKeys = typeKeys.filter((key) => body.data[key] !== undefined);
      const needed = [...new Set(presentKeys.map(privilegeOf))];
      let granted: boolean[];
      try {
        granted = await Promise.all(needed.map((priv) => hasPrivilege(client, params.vmid, priv)));
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check permissions for guest options update');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      const grantedSet = new Set(needed.filter((_, index) => granted[index]));
      const missingKey = presentKeys.find((key) => !grantedSet.has(privilegeOf(key)));
      if (missingKey !== undefined) {
        reply.code(403).send({ error: 'forbidden', missing: privilegeOf(missingKey) });
        return;
      }

      // Editing the agent replaces PVE's whole `agent` property string, so the unmodeled sub-options
      // it already holds (`type`, `freeze-fs-on-backup`, ...) are read first and carried over.
      let currentAgent: unknown;
      if (params.type === 'qemu' && body.data.agent !== undefined) {
        try {
          currentAgent = await fetchQemuAgent(client, params.node, params.vmid);
        } catch (error) {
          if (sendPveError(reply, error)) return;
          app.log.warn({ err: error }, 'Failed to read current config for guest options update');
          reply.code(502).send({ error: 'pve-unreachable' });
          return;
        }
      }

      const composed = compose(params.type, body.data, currentAgent);
      const config: Record<string, string | number> = { ...composed.put };
      if (composed.del.length > 0) config.delete = composed.del.join(',');
      const changed = composed.changed;

      try {
        await callConfigUpdate(client, params.type, params.node, params.vmid, config);
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Guest options update request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      // Which of the changed keys PVE is holding back until the guest restarts. A failure to read
      // the pending list never fails the (already applied) update -- it just reports none.
      let pending: string[] = [];
      try {
        const rows = await fetchPending(client, params.type, params.node, params.vmid);
        const held = new Set(
          rows
            .filter((row) => row.pending !== undefined || (row.delete !== undefined && Boolean(row.delete)))
            .map((row) => row.key),
        );
        pending = changed.filter((key) => held.has(key));
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to read pending config after guest options update');
      }

      // One line per update; the changed *keys* only, never their values.
      app.log.info(
        { username: identity.username, node: params.node, type: params.type, vmid: params.vmid, changed, pending },
        'Guest options updated',
      );
      reply.code(200).send({ ok: true, changed, pending });
    },
  );
}
