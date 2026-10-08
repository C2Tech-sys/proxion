import { USE_FIXTURES } from '@/api/client';
import {
  getFixtureNotifySettings,
  muteFixtureNotifications,
  putFixtureNotifySettings,
} from '@/api/fixtures';

/**
 * Alert notifications (T43) -- which channels (webhook/email) the server has configured, and a
 * button to send a real test message through each. A separate module from `client.ts`/`actions.ts`
 * (same rationale as `prefs.ts`): its own tiny fixture-mode behavior, its own hooks
 * (`notifyHooks.ts`), not part of `ApiClient`.
 */
export interface NotifyStatus {
  configured: { webhook: boolean; email: boolean };
  minSeverity: 'warning' | 'error';
  includeResolved: boolean;
  /** Present when the server disabled notifications over an invalid `PROXION_NOTIFY_*` value (T59); one line, secret-free. Never set in fixture mode. */
  error?: string;
}

/** One entry per channel the server has configured -- `'ok'` or a short, already-sanitised
 *  failure reason (never a raw URL/token/credential -- see `apps/server/src/notify/notifier.ts`). */
export type NotifyTestResults = Record<string, string>;

const STATUS_PATH = '/api/notify/status';
const TEST_PATH = '/api/notify/test';

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let detail: string | undefined;
    try {
      const body = (await res.clone().json()) as { error?: string };
      detail = body?.error;
    } catch {
      detail = undefined;
    }
    throw new Error(detail ?? `Request to ${path} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

// --- Fixture mode -------------------------------------------------------------------------------
// No real backend in the demo: a plausible "one channel configured" status, and a simulated
// round-trip on the test button so the Preferences page's control actually does something.
const FIXTURE_LATENCY_MS = 300;

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), FIXTURE_LATENCY_MS));
}

export function getNotifyStatus(): Promise<NotifyStatus> {
  if (USE_FIXTURES) {
    return delay({ configured: { webhook: true, email: false }, minSeverity: 'warning', includeResolved: true });
  }
  return requestJson<NotifyStatus>(STATUS_PATH);
}

export function sendTestNotification(): Promise<NotifyTestResults> {
  if (USE_FIXTURES) {
    return delay({ webhook: 'ok' });
  }
  return requestJson<{ results: NotifyTestResults }>(TEST_PATH, { method: 'POST' }).then((body) => body.results);
}

// --- Runtime-editable settings (T64) ------------------------------------------------------------

export type NotifyKind = 'backup' | 'task' | 'storage';
export type WebhookFormat = 'generic' | 'discord' | 'slack' | 'ntfy' | 'gotify';
export type MuteSpan = '1h' | '8h' | '24h' | '7d';

/** "Leave what the server has stored" -- the only way the browser refers to a secret it was never given. */
export interface KeepSecret {
  keep: true;
}

/**
 * `GET /api/notify/settings`: the effective settings with every secret masked. The webhook
 * address is reduced to its host, the token to "is one set", the SMTP URL to host/port/TLS/user.
 */
export interface NotifySettingsView {
  source: 'file' | 'env';
  enabled: boolean;
  /** Only present while the snooze is still in the future. */
  muteUntil?: string;
  mutedKinds: NotifyKind[];
  minSeverity: 'warning' | 'error';
  includeResolved: boolean;
  debounceMs: number;
  siteName: string;
  publicUrl?: string;
  webhook?: { url: { host: string; masked: true }; format: WebhookFormat; token: { set: boolean } };
  email?: {
    smtpUrl: { host: string; port: number; secure: boolean; user?: string; set: true };
    from: string;
    to: string[];
  };
  channels: { webhook: boolean; email: boolean };
  /** `PROXION_NOTIFY_ALLOWED_HOSTS` (host names, `*.example.com` wildcards), or `null` when destinations are unrestricted. */
  allowedHosts: string[] | null;
  /** The `PROXION_NOTIFY_*` error (T59), while the environment is what is in force. */
  error?: string;
}

/**
 * `PUT /api/notify/settings`: a full replacement of the settings. `webhook`/`email` omitted (or
 * `null`) remove the channel; `muteUntil` omitted keeps the current snooze. A secret is either the
 * new value or `{ keep: true }`; `webhook.token: null` clears the stored token.
 */
export interface NotifySettingsPutBody {
  enabled: boolean;
  muteUntil?: string | null;
  mutedKinds: NotifyKind[];
  minSeverity: 'warning' | 'error';
  includeResolved: boolean;
  debounceMs: number;
  siteName: string;
  publicUrl?: string | null;
  webhook?: { url: string | KeepSecret; format: WebhookFormat; token?: string | KeepSecret | null } | null;
  email?: { smtpUrl: string | KeepSecret; from: string; to: string[] } | null;
}

const SETTINGS_PATH = '/api/notify/settings';
const MUTE_PATH = '/api/notify/mute';

/** Like `requestJson`, but a 400 from the settings routes carries the useful sentence in `message`
 *  (`{ error: 'invalid-settings', message: 'debounceMs: ...' }`), which is what the form shows. */
async function settingsRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let detail: string | undefined;
    try {
      const body = (await res.clone().json()) as { error?: string; message?: string };
      detail = body?.message ?? body?.error;
    } catch {
      detail = undefined;
    }
    throw new Error(detail ?? `Request to ${path} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export function getNotifySettings(): Promise<NotifySettingsView> {
  if (USE_FIXTURES) {
    return delay(getFixtureNotifySettings());
  }
  return settingsRequest<NotifySettingsView>(SETTINGS_PATH);
}

export function putNotifySettings(body: NotifySettingsPutBody): Promise<NotifySettingsView> {
  if (USE_FIXTURES) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(putFixtureNotifySettings(body));
        } catch (error) {
          reject(error instanceof Error ? error : new Error('The settings could not be saved.'));
        }
      }, FIXTURE_LATENCY_MS);
    });
  }
  return settingsRequest<NotifySettingsView>(SETTINGS_PATH, { method: 'PUT', body: JSON.stringify(body) });
}

/** The snooze buttons: `null` clears the mute. Returns the updated masked settings. */
export function muteNotifications(span: MuteSpan | null): Promise<NotifySettingsView> {
  if (USE_FIXTURES) {
    return delay(muteFixtureNotifications(span));
  }
  return settingsRequest<NotifySettingsView>(MUTE_PATH, { method: 'POST', body: JSON.stringify({ for: span }) });
}
