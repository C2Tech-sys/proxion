import { USE_FIXTURES } from '@/api/client';

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
