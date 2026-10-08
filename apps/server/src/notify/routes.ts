import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PveApiError, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import { SESSION_COOKIE } from '../auth/session.js';
import { formatPveErrorMessage, sanitizeMessage } from '../actions/shared.js';
import {
  MAX_DEBOUNCE_MS,
  MIN_DEBOUNCE_MS,
  NOTIFY_KINDS,
  WEBHOOK_FORMATS,
  buildNotifyChannels,
  effectiveNotifySettings,
  httpUrlField,
  isMuted,
  isoDateField,
  notifySettingsSchema,
  recipientField,
  smtpUrlField,
  toPersistable,
  type EffectiveNotifySettings,
  type NotifySettings,
} from './settingsStore.js';

/** Same bucketing rationale as `prefsRoutes.ts`'s own `rateLimitKey`: per-session (not per-IP),
 *  so one browser's test clicks never eat into another signed-in user's quota. */
function rateLimitKey(req: FastifyRequest): string {
  return (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE] ?? req.ip;
}

const TEST_RATE_LIMIT = { max: 5, timeWindow: '1 minute' } as const;
const WRITE_RATE_LIMIT = { max: 20, timeWindow: '1 minute' } as const;

export interface NotifyStatusResponse {
  configured: { webhook: boolean; email: boolean };
  minSeverity: 'warning' | 'error';
  includeResolved: boolean;
  /** Present when a `PROXION_NOTIFY_*` value was invalid and notifications are therefore disabled (secret-free, one line). */
  error?: string;
}

/**
 * The masked view of the settings (T64): what `GET`/`PUT /api/notify/settings` and
 * `POST /api/notify/mute` return. Secrets never appear -- the webhook URL is reduced to its host
 * (path and query commonly carry the secret: Discord/Slack webhook ids, ntfy topics), the token to
 * "is one set", and the SMTP URL to host/port/TLS/user (never the password).
 */
export interface NotifySettingsView {
  source: 'file' | 'env';
  enabled: boolean;
  /** Only present while the mute is still in the future. */
  muteUntil?: string;
  mutedKinds: Array<(typeof NOTIFY_KINDS)[number]>;
  minSeverity: 'warning' | 'error';
  includeResolved: boolean;
  debounceMs: number;
  siteName: string;
  publicUrl?: string;
  webhook?: { url: { host: string; masked: true }; format: (typeof WEBHOOK_FORMATS)[number]; token: { set: boolean } };
  email?: {
    smtpUrl: { host: string; port: number; secure: boolean; user?: string; set: true };
    from: string;
    to: string[];
  };
  channels: { webhook: boolean; email: boolean };
  /** The T59 environment error; only reported while the environment is what is in force. */
  error?: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function maskSmtp(smtpUrl: string): NonNullable<NotifySettingsView['email']>['smtpUrl'] {
  const url = new URL(smtpUrl);
  const secure = url.protocol === 'smtps:';
  const port = url.port ? Number(url.port) : secure ? 465 : 587;
  let user: string | undefined;
  if (url.username) {
    try {
      user = decodeURIComponent(url.username);
    } catch {
      user = url.username;
    }
  }
  return { host: url.hostname, port, secure, ...(user !== undefined ? { user } : {}), set: true };
}

export function maskNotifySettings(
  effective: EffectiveNotifySettings,
  envError: string | undefined,
  nowMs: number,
): NotifySettingsView {
  const view: NotifySettingsView = {
    source: effective.source,
    enabled: effective.enabled,
    mutedKinds: NOTIFY_KINDS.filter((kind) => effective.mutedKinds.includes(kind)),
    minSeverity: effective.minSeverity,
    includeResolved: effective.includeResolved,
    debounceMs: effective.debounceMs,
    siteName: effective.siteName,
    channels: { webhook: Boolean(effective.webhook), email: Boolean(effective.email) },
  };
  if (effective.muteUntil && isMuted(effective, nowMs)) view.muteUntil = effective.muteUntil;
  if (effective.publicUrl) view.publicUrl = effective.publicUrl;
  if (effective.webhook) {
    view.webhook = {
      url: { host: hostOf(effective.webhook.url), masked: true },
      format: effective.webhook.format,
      token: { set: Boolean(effective.webhook.token) },
    };
  }
  if (effective.email) {
    view.email = {
      smtpUrl: maskSmtp(effective.email.smtpUrl),
      from: effective.email.from,
      to: effective.email.to,
    };
  }
  if (envError && effective.source === 'env') view.error = envError;
  return view;
}

// --- PUT body ---------------------------------------------------------------------------------

/** "Leave what is stored" for a secret the browser was never given. */
const keepSchema = z.object({ keep: z.literal(true) }).strict();
type Keep = z.infer<typeof keepSchema>;

const putBodySchema = z
  .object({
    enabled: z.boolean(),
    /** Omitted = leave the current snooze alone; `null` = clear it. */
    muteUntil: isoDateField.nullable().optional(),
    mutedKinds: z.array(z.enum(NOTIFY_KINDS)).max(NOTIFY_KINDS.length),
    minSeverity: z.enum(['warning', 'error']),
    includeResolved: z.boolean(),
    debounceMs: z.number().int().min(MIN_DEBOUNCE_MS).max(MAX_DEBOUNCE_MS),
    siteName: z.string().trim().min(1).max(64),
    publicUrl: httpUrlField.nullable().optional(),
    /** Omitted or `null` = no webhook. */
    webhook: z
      .object({
        url: z.union([httpUrlField, keepSchema]),
        format: z.enum(WEBHOOK_FORMATS),
        /** string = set, `{ keep: true }` = leave the stored token, `null`/omitted = no token. */
        token: z.union([z.string().min(1).max(4096), keepSchema]).nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    /** Omitted or `null` = no email channel. */
    email: z
      .object({
        smtpUrl: z.union([smtpUrlField, keepSchema]),
        from: z.string().trim().min(1).max(320),
        to: z.array(recipientField).min(1).max(50),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

type PutBody = z.infer<typeof putBodySchema>;

const muteBodySchema = z.object({ for: z.enum(['1h', '8h', '24h', '7d']).nullable() }).strict();
const MUTE_DURATIONS_MS = {
  '1h': 3_600_000,
  '8h': 8 * 3_600_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
} as const;

/** One line per problem, field path + message only -- never the offending value (it may be a secret). */
function describeIssues(error: z.ZodError): string {
  const lines: string[] = [];
  for (const issue of error.issues) {
    // A `string | { keep: true }` union reports as one opaque issue; the first branch (the string
    // rule, e.g. "must be an absolute http(s) URL") is the useful message.
    const message =
      issue.code === 'invalid_union' ? (issue.errors[0]?.[0]?.message ?? issue.message) : issue.message;
    const where = issue.path.length > 0 ? issue.path.join('.') : 'body';
    lines.push(`${where}: ${message}`);
  }
  return [...new Set(lines)].join('; ');
}

function isKeep(value: unknown): value is Keep {
  return typeof value === 'object' && value !== null && (value as Keep).keep === true;
}

type ResolveResult = { ok: true; settings: NotifySettings } | { ok: false; message: string };

/** Turns a validated PUT body into the settings to persist, resolving `{ keep: true }` against
 *  what is in force now. A kept token is only honoured while the webhook host is unchanged --
 *  otherwise a caller with `Sys.Modify` could repoint the webhook at their own server and have
 *  the stored token sent there. */
function resolvePut(body: PutBody, current: EffectiveNotifySettings): ResolveResult {
  const settings: NotifySettings = {
    version: 1,
    enabled: body.enabled,
    mutedKinds: NOTIFY_KINDS.filter((kind) => body.mutedKinds.includes(kind)),
    minSeverity: body.minSeverity,
    includeResolved: body.includeResolved,
    debounceMs: body.debounceMs,
    siteName: body.siteName,
  };
  const muteUntil = body.muteUntil === undefined ? current.muteUntil : (body.muteUntil ?? undefined);
  if (muteUntil) settings.muteUntil = muteUntil;
  if (body.publicUrl) settings.publicUrl = body.publicUrl;

  if (body.webhook) {
    const storedWebhook = current.webhook;
    let url: string;
    if (isKeep(body.webhook.url)) {
      if (!storedWebhook) return { ok: false, message: 'webhook.url: there is no stored webhook URL to keep' };
      url = storedWebhook.url;
    } else {
      url = body.webhook.url;
    }
    let token: string | undefined;
    if (isKeep(body.webhook.token)) {
      if (storedWebhook?.token) {
        if (hostOf(url) !== hostOf(storedWebhook.url)) {
          return { ok: false, message: 'webhook.token: enter the token again when you change the webhook address' };
        }
        token = storedWebhook.token;
      }
    } else if (typeof body.webhook.token === 'string') {
      token = body.webhook.token;
    }
    settings.webhook = { url, format: body.webhook.format, ...(token !== undefined ? { token } : {}) };
  }

  if (body.email) {
    let smtpUrl: string;
    if (isKeep(body.email.smtpUrl)) {
      if (!current.email) return { ok: false, message: 'email.smtpUrl: there is no stored SMTP URL to keep' };
      smtpUrl = current.email.smtpUrl;
    } else {
      smtpUrl = body.email.smtpUrl;
    }
    settings.email = { smtpUrl, from: body.email.from, to: body.email.to };
  }

  const checked = notifySettingsSchema.safeParse(settings);
  if (!checked.success) return { ok: false, message: describeIssues(checked.error) };
  return { ok: true, settings: checked.data };
}

// --- privilege ----------------------------------------------------------------------------------

/** Whether the caller's own credentials hold `Sys.Modify` on `/`, via
 *  `GET /access/permissions?path=/` (real PVE nests the result under the requested path; falls
 *  back to a flat map like `shared.ts`'s `hasPrivilege`). Additive and local to this file. */
async function hasRootSysModify(client: PveClient): Promise<boolean> {
  const perms = (await client.get('/access/permissions', { path: '/' })) as Record<string, unknown>;
  const scoped = (perms['/'] as Record<string, unknown> | undefined) ?? perms;
  return Boolean(scoped['Sys.Modify']);
}

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

/**
 * `GET /api/notify/status` (any authenticated identity, including token mode -- no secrets in
 * the response, just which channels exist) and `POST /api/notify/test` (session only; a service
 * token is a shared, unattended identity, same rationale as every other write route's
 * `writes-disabled-in-token-mode`). `app.notifier` is only set when at least one channel is
 * configured (see `app.ts`), so `not-configured` here is simply "no notifier at all".
 *
 * T64 adds the runtime-editable settings: `GET /api/notify/settings` (any identity, masked),
 * `PUT /api/notify/settings` and `POST /api/notify/mute` (session only AND `Sys.Modify` on `/`).
 * Request bodies are never logged.
 */
export default async function notifyRoutes(app: FastifyInstance): Promise<void> {
  const currentSettings = (): EffectiveNotifySettings =>
    effectiveNotifySettings(app.proxionConfig, app.notifySettingsStore.current);
  const view = (): NotifySettingsView =>
    maskNotifySettings(currentSettings(), app.proxionConfig.notifyConfigError, Date.now());

  app.get('/api/notify/status', async (req, reply) => {
    const identity = await resolveIdentity(app, req);
    if (!identity) {
      reply.code(401).send({ error: 'Not authenticated' });
      return;
    }

    const settings = currentSettings();
    const body: NotifyStatusResponse = {
      configured: { webhook: Boolean(settings.webhook), email: Boolean(settings.email) },
      minSeverity: settings.minSeverity,
      includeResolved: settings.includeResolved,
    };
    const { notifyConfigError } = app.proxionConfig;
    if (notifyConfigError && settings.source === 'env') body.error = notifyConfigError;
    reply.send(body);
  });

  app.get('/api/notify/settings', async (req, reply) => {
    const identity = await resolveIdentity(app, req);
    if (!identity) {
      reply.code(401).send({ error: 'Not authenticated' });
      return;
    }
    reply.send(view());
  });

  /** Shared gate for the two settings writes: 401 / token 403 (before any PVE call) / `Sys.Modify`
   *  on `/` 403. Returns `true` when the caller may proceed. */
  async function authoriseWrite(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const identity = await resolveIdentity(app, req);
    if (!identity) {
      reply.code(401).send({ error: 'Not authenticated' });
      return false;
    }
    if (identity.credentials.type === 'token') {
      reply.code(403).send({ error: 'writes-disabled-in-token-mode' });
      return false;
    }
    try {
      if (!(await hasRootSysModify(identity.client))) {
        reply.code(403).send({ error: 'forbidden', missing: ['Sys.Modify'] });
        return false;
      }
    } catch (error) {
      if (sendPveError(reply, error)) return false;
      throw error;
    }
    return true;
  }

  /** Persists, hot-reloads and replies with the masked view. */
  async function persistAndReload(reply: FastifyReply, settings: NotifySettings): Promise<void> {
    try {
      buildNotifyChannels(settings);
    } catch {
      reply.code(400).send({ error: 'invalid-settings', message: 'The webhook or email settings could not be used.' });
      return;
    }
    try {
      await app.notifySettingsStore.save(settings);
    } catch {
      app.log.error('Notification settings could not be written to the data directory');
      reply.code(500).send({ error: 'settings-write-failed', message: 'The settings could not be saved on the server.' });
      return;
    }
    try {
      await app.reloadNotifier();
    } catch {
      app.log.error('Notification settings were saved but the notifier could not be reloaded');
      reply.code(500).send({ error: 'reload-failed', message: 'The settings were saved but could not be applied.' });
      return;
    }
    reply.send(view());
  }

  app.put(
    '/api/notify/settings',
    { config: { rateLimit: { ...WRITE_RATE_LIMIT, keyGenerator: rateLimitKey } } },
    async (req, reply) => {
      if (!(await authoriseWrite(req, reply))) return;

      const parsed = putBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400).send({ error: 'invalid-settings', message: describeIssues(parsed.error) });
        return;
      }
      const resolved = resolvePut(parsed.data, currentSettings());
      if (!resolved.ok) {
        reply.code(400).send({ error: 'invalid-settings', message: resolved.message });
        return;
      }
      await persistAndReload(reply, resolved.settings);
    },
  );

  app.post(
    '/api/notify/mute',
    { config: { rateLimit: { ...WRITE_RATE_LIMIT, keyGenerator: rateLimitKey } } },
    async (req, reply) => {
      if (!(await authoriseWrite(req, reply))) return;

      const parsed = muteBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400).send({ error: 'invalid-settings', message: describeIssues(parsed.error) });
        return;
      }
      // Everything else stays as it is; note this writes the whole effective configuration to the
      // settings file (copying env-sourced values on first use), see the README.
      const settings = toPersistable(currentSettings());
      delete settings.muteUntil;
      if (parsed.data.for !== null) {
        settings.muteUntil = new Date(Date.now() + MUTE_DURATIONS_MS[parsed.data.for]).toISOString();
      }
      await persistAndReload(reply, settings);
    },
  );

  app.post(
    '/api/notify/test',
    { config: { rateLimit: { ...TEST_RATE_LIMIT, keyGenerator: rateLimitKey } } },
    async (req, reply) => {
      const identity = await resolveIdentity(app, req);
      if (!identity) {
        reply.code(401).send({ error: 'Not authenticated' });
        return;
      }
      if (identity.credentials.type === 'token') {
        reply.code(403).send({ error: 'writes-disabled-in-token-mode' });
        return;
      }
      if (!app.notifier) {
        const { notifyConfigError } = app.proxionConfig;
        reply.code(400).send(
          notifyConfigError && currentSettings().source === 'env'
            ? { error: 'not-configured', message: notifyConfigError }
            : { error: 'not-configured' },
        );
        return;
      }

      // A test always sends -- it deliberately ignores `enabled`, `muteUntil` and `mutedKinds`.
      const results = await app.notifier.sendTest();
      reply.send({ results });
    },
  );
}
