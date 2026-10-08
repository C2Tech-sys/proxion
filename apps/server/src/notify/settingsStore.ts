import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import { createEmailChannel } from './channels/email.js';
import { createWebhookChannel } from './channels/webhook.js';
import type { NotifyLogger } from './notifier.js';
import type { NotifyChannel } from './types.js';

/**
 * Runtime-editable notification settings (T64), layered over the `PROXION_NOTIFY_*` env defaults.
 *
 * `<PROXION_DATA_DIR>/notify-settings.json` (mode 0600, atomic temp + rename -- same convention as
 * `notify-state.json` and `prefs/store.ts`) holds the whole effective configuration, secrets
 * included, once anybody has saved from the Preferences page. While the file is absent the env
 * values stay in force (the env is the bootstrap); once it exists it wins outright -- there is no
 * per-field merge, so what the form shows is exactly what is in effect.
 */

export const NOTIFY_SETTINGS_FILE_NAME = 'notify-settings.json';
const SETTINGS_VERSION = 1;

export const NOTIFY_KINDS = ['backup', 'task', 'storage'] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];
export const WEBHOOK_FORMATS = ['generic', 'discord', 'slack', 'ntfy', 'gotify'] as const;
export type WebhookFormatName = (typeof WEBHOOK_FORMATS)[number];

export const MIN_DEBOUNCE_MS = 1_000;
export const MAX_DEBOUNCE_MS = 600_000;

function isUrlWithProtocol(value: string, protocols: readonly string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export const httpUrlField = z
  .string()
  .max(2048)
  .refine((value) => isUrlWithProtocol(value, ['http:', 'https:']), { message: 'must be an absolute http(s) URL' });

export const smtpUrlField = z
  .string()
  .max(2048)
  .refine((value) => isUrlWithProtocol(value, ['smtp:', 'smtps:']), { message: 'must be an smtp:// or smtps:// URL' });

export const isoDateField = z
  .string()
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value), {
    message: 'must be an ISO 8601 date-time',
  });

/** A bare address: no whitespace (so no CR/LF header injection), no angle brackets, quotes or
 *  commas (no display names, one address per entry), 3..320 characters. Mirrored in `config.ts`
 *  for the env path. */
const BARE_EMAIL_RE = /^[^\s@,<>"]+@[^\s@,<>"]+\.[^\s@,<>"]+$/;
export const emailAddressField = z
  .string()
  .min(3)
  .max(320)
  .regex(BARE_EMAIL_RE, { message: 'must be a bare email address such as ops@example.com' });
export const recipientField = emailAddressField;

const webhookSettingsSchema = z
  .object({
    url: httpUrlField,
    format: z.enum(WEBHOOK_FORMATS),
    token: z.string().min(1).max(4096).optional(),
  })
  .strict();

const emailSettingsSchema = z
  .object({
    smtpUrl: smtpUrlField,
    from: emailAddressField,
    to: z.array(recipientField).min(1).max(50),
  })
  .strict();

/** The persisted document (and the shape every consumer works with). */
export const notifySettingsSchema = z
  .object({
    version: z.literal(SETTINGS_VERSION),
    enabled: z.boolean(),
    muteUntil: isoDateField.optional(),
    mutedKinds: z.array(z.enum(NOTIFY_KINDS)).max(NOTIFY_KINDS.length),
    minSeverity: z.enum(['warning', 'error']),
    includeResolved: z.boolean(),
    debounceMs: z.number().int().min(MIN_DEBOUNCE_MS).max(MAX_DEBOUNCE_MS),
    siteName: z.string().trim().min(1).max(64),
    publicUrl: httpUrlField.optional(),
    webhook: webhookSettingsSchema.optional(),
    email: emailSettingsSchema.optional(),
  })
  .strict();

export type NotifySettings = z.infer<typeof notifySettingsSchema>;
export type EffectiveNotifySettings = NotifySettings & { source: 'file' | 'env' };

/**
 * The configuration in force: the file's settings when the file exists, else the env-derived
 * values. `source` says which. The env's recipient list is a comma-separated string; it is split
 * here so both sources share one shape.
 */
export function effectiveNotifySettings(
  config: Config,
  fileSettings: NotifySettings | undefined,
): EffectiveNotifySettings {
  if (fileSettings) return { ...fileSettings, source: 'file' };

  const settings: EffectiveNotifySettings = {
    version: SETTINGS_VERSION,
    source: 'env',
    enabled: true,
    mutedKinds: [],
    minSeverity: config.PROXION_NOTIFY_MIN_SEVERITY,
    includeResolved: config.PROXION_NOTIFY_INCLUDE_RESOLVED,
    debounceMs: config.PROXION_NOTIFY_DEBOUNCE_MS,
    siteName: config.PROXION_NOTIFY_SITE_NAME,
  };
  if (config.PROXION_PUBLIC_URL) settings.publicUrl = config.PROXION_PUBLIC_URL;
  if (config.PROXION_NOTIFY_WEBHOOK_URL) {
    settings.webhook = {
      url: config.PROXION_NOTIFY_WEBHOOK_URL,
      format: config.PROXION_NOTIFY_WEBHOOK_FORMAT,
      ...(config.PROXION_NOTIFY_WEBHOOK_TOKEN ? { token: config.PROXION_NOTIFY_WEBHOOK_TOKEN } : {}),
    };
  }
  if (config.PROXION_NOTIFY_SMTP_URL && config.PROXION_NOTIFY_EMAIL_FROM && config.PROXION_NOTIFY_EMAIL_TO) {
    settings.email = {
      smtpUrl: config.PROXION_NOTIFY_SMTP_URL,
      from: config.PROXION_NOTIFY_EMAIL_FROM,
      to: config.PROXION_NOTIFY_EMAIL_TO.split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    };
  }
  return settings;
}

/** Strips the `source` marker so the result can be validated/written as a `NotifySettings`. */
export function toPersistable(effective: EffectiveNotifySettings): NotifySettings {
  const { source: _source, ...rest } = effective;
  void _source;
  return rest;
}

/** One channel per configured target (webhook, then email). Throws if a channel can't be built
 *  from the given values; callers that take user input build channels BEFORE writing the file. */
export function buildNotifyChannels(settings: NotifySettings): NotifyChannel[] {
  const channels: NotifyChannel[] = [];
  if (settings.webhook) {
    channels.push(
      createWebhookChannel({
        url: settings.webhook.url,
        format: settings.webhook.format,
        token: settings.webhook.token,
      }),
    );
  }
  if (settings.email) {
    channels.push(
      createEmailChannel({
        smtpUrl: settings.email.smtpUrl,
        from: settings.email.from,
        to: settings.email.to.join(','),
      }),
    );
  }
  return channels;
}

/** Whether `muteUntil` is set and still in the future at `nowMs`. */
export function isMuted(settings: Pick<NotifySettings, 'muteUntil'>, nowMs: number): boolean {
  if (!settings.muteUntil) return false;
  const until = Date.parse(settings.muteUntil);
  return !Number.isNaN(until) && until > nowMs;
}

/**
 * Owns `notify-settings.json`. Holds the parsed file in memory (`current`, `undefined` while no
 * valid file exists) so every reader sees the last saved state. Never logs a document's contents
 * -- it holds secrets -- only that a file was ignored, and why in schema terms (paths, no values).
 */
export class NotifySettingsStore {
  private constructor(
    private readonly filePath: string,
    private readonly dataDir: string,
    private currentSettings: NotifySettings | undefined,
  ) {}

  /** Reads the file if present. A file that is unreadable, not JSON, or fails the schema is
   *  ignored with a `warn` (the env defaults then stay in force) -- it never stops the server. */
  static async load(dataDir: string, log: Pick<NotifyLogger, 'warn'>): Promise<NotifySettingsStore> {
    const filePath = path.join(dataDir, NOTIFY_SETTINGS_FILE_NAME);
    let current: NotifySettings | undefined;
    let text: string | undefined;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn({ file: NOTIFY_SETTINGS_FILE_NAME }, 'Notification settings file could not be read; ignoring it');
      }
    }
    if (text !== undefined) {
      try {
        const parsed = notifySettingsSchema.safeParse(JSON.parse(text));
        if (parsed.success) {
          current = parsed.data;
        } else {
          const where = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'))].join(', ');
          log.warn(
            { file: NOTIFY_SETTINGS_FILE_NAME, fields: where },
            'Notification settings file is invalid; ignoring it and using the environment defaults',
          );
        }
      } catch {
        log.warn(
          { file: NOTIFY_SETTINGS_FILE_NAME },
          'Notification settings file is not valid JSON; ignoring it and using the environment defaults',
        );
      }
    }
    return new NotifySettingsStore(filePath, dataDir, current);
  }

  /** The saved settings, or `undefined` while the env defaults are in force. */
  get current(): NotifySettings | undefined {
    return this.currentSettings;
  }

  /** Atomic write (temp file in the same directory, mode 0600, then rename). Throws on I/O
   *  failure, leaving the previous file and in-memory state untouched. */
  async save(settings: NotifySettings): Promise<void> {
    const validated = notifySettingsSchema.parse(settings);
    const tmp = path.join(this.dataDir, `.${NOTIFY_SETTINGS_FILE_NAME}.${randomBytes(6).toString('hex')}.tmp`);
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(tmp, JSON.stringify(validated, null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.filePath);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
    this.currentSettings = validated;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The persisted, runtime-editable notification settings (T64). */
    notifySettingsStore: NotifySettingsStore;
    /** Rebuilds the channels from the effective settings and swaps `app.notifier` without a
     *  restart (T64). Resolves once the swap is done; rejects if the new notifier cannot be built
     *  (the previous one then stays in place). */
    reloadNotifier(): Promise<void>;
  }
}
