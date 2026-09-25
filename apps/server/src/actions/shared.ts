import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PveClient } from '@proxion/pve-api';
import { SESSION_COOKIE } from '../auth/session.js';

/**
 * Helpers shared between `routes.ts` (guest power actions + rename/notes) and
 * `snapshotRoutes.ts` (snapshot create/delete/rollback). Kept in their own module, rather than
 * exported from `routes.ts` directly, so the two route files can import from each other's
 * neighbour without a circular `routes.ts` <-> `snapshotRoutes.ts` import: `routes.ts` calls
 * `registerSnapshotRoutes` from `snapshotRoutes.ts`, and both need these same schemas/helpers --
 * a cycle between them would leave whichever module's top-level `const`s (e.g.
 * `MAX_DESCRIPTION_LENGTH`, used to build a zod schema at module-load time) evaluate to
 * `undefined` in the other, depending on which side of the cycle loads first.
 */

export const guestTypeSchema = z.enum(['qemu', 'lxc']);
export const vmidSchema = z.coerce.number().int().positive();

/** PVE's own limit on the `description` config field (both qemu and lxc), and on a snapshot's
 * own `description` field. */
export const MAX_DESCRIPTION_LENGTH = 8192;

// The control-character range this strips from a `description` before it's sent to PVE -- every
// C0 control character and DEL except `\n` (0x0a) and `\t` (0x09), which are left alone.
// eslint-disable-next-line no-control-regex
const DESCRIPTION_CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Normalises a `description` to `\n` line endings and strips control characters other than
 * `\n`/`\t` before it's sent to PVE. Never lengthens the string, so validating a schema's
 * `description.max()` against the *un*-sanitised input is still a safe upper bound. */
export function sanitizeDescription(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(DESCRIPTION_CONTROL_CHARS_RE, '');
}

const MAX_MESSAGE_LENGTH = 300;

// The control-character range is exactly what this needs to strip from a PVE error message
// before it's relayed to the browser.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/g;

/** PVE's own error message, trimmed of control characters and capped in length before it's
 * relayed to the browser. */
export function sanitizeMessage(message: string): string {
  const stripped = message.replace(CONTROL_CHARS_RE, '').trim();
  return stripped.length > MAX_MESSAGE_LENGTH ? `${stripped.slice(0, MAX_MESSAGE_LENGTH)}…` : stripped;
}

/** Rate-limit key: per session when there is one (the signed cookie value is already unique per
 * session and never logged/parsed here), otherwise per caller IP. */
export function rateLimitKey(req: FastifyRequest): string {
  const sid = req.cookies?.[SESSION_COOKIE];
  return sid ? `session:${sid}` : req.ip;
}

/** Whether the caller's own credentials (`client`) hold `privilege` on `/vms/{vmid}`, via
 * `GET /access/permissions?path=/vms/{vmid}`. Real PVE nests the result under the requested path
 * (`{ "/vms/113": { "VM.Snapshot": 1, ... } }`); falls back to a flat map in case that ever
 * changes (mirrors `thumbnailRoutes.ts`). */
export async function hasPrivilege(client: PveClient, vmid: number, privilege: string): Promise<boolean> {
  const vmPath = `/vms/${vmid}`;
  const perms = (await client.get('/access/permissions', { path: vmPath })) as Record<string, unknown>;
  const scoped = (perms[vmPath] as Record<string, unknown> | undefined) ?? perms;
  return Boolean(scoped[privilege]);
}

/** Same as `hasPrivilege`, but for a node-scoped privilege on `/nodes/{node}` (e.g.
 * `Sys.PowerMgmt`) instead of a guest-scoped one on `/vms/{vmid}` -- used by `nodeRoutes.ts`.
 * Additive next to `hasPrivilege` rather than a generalisation of it, so the existing guest-action
 * callers/tests are untouched. */
export async function hasNodePrivilege(client: PveClient, node: string, privilege: string): Promise<boolean> {
  const nodePath = `/nodes/${node}`;
  const perms = (await client.get('/access/permissions', { path: nodePath })) as Record<string, unknown>;
  const scoped = (perms[nodePath] as Record<string, unknown> | undefined) ?? perms;
  return Boolean(scoped[privilege]);
}
