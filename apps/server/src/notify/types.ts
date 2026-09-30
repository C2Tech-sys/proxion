import type { Alert, AlertSeverity } from '@proxion/core';

/** Re-exported so the rest of `notify/**` never imports `@proxion/core` directly for this. */
export type { Alert, AlertSeverity };

/**
 * What happened to one alert between two snapshots (or, for `'summary-item'`/`'test'`, a
 * synthetic entry that isn't a transition at all -- see `notifier.ts`'s doc comment for the full
 * transition taxonomy).
 */
export type NotifyEventType =
  | 'opened'
  | 'resolved'
  | 'cleared'
  | 'escalated'
  | 'summary-item'
  | 'test';

/** One line of a notification message. Mirrors the shape of `Alert` closely (see
 *  `packages/core/src/alerts.ts`) so formatting an event is mostly "pick a label for `type`,
 *  reuse the rest". */
export interface NotifyEvent {
  type: NotifyEventType;
  severity: AlertSeverity;
  kind: Alert['kind'];
  title: string;
  detail?: string | undefined;
  node?: string | undefined;
  vmid?: string | undefined;
  /** Unix epoch seconds. */
  at: number;
  /** Deep link into the app for this alert, when `PROXION_PUBLIC_URL` is configured -- see
   *  `notify/format.ts`'s `buildDeepLink`. */
  url?: string | undefined;
}

/** One outbound notification: either the one-time "notifications are active" summary sent on
 *  first run, a batch of transitions, or a synthetic test message from the Preferences page's
 *  "Send test notification" button. */
export interface NotifyMessage {
  kind: 'summary' | 'transitions' | 'test';
  siteName: string;
  events: NotifyEvent[];
}

/** A notification channel -- `webhook` or `email` today. `send` must never need the caller to
 *  catch anything: `Notifier` always awaits it inside its own try/catch, but a channel is free to
 *  throw (e.g. a non-2xx response, a timeout, an SMTP error) and the caller will log/retry. */
export interface NotifyChannel {
  readonly name: 'webhook' | 'email';
  /** Host name only (never a path, query string, token or credential) -- the one thing this
   *  channel is allowed to put in a log line. */
  readonly host: string;
  send(message: NotifyMessage): Promise<void>;
}
