import { eventLine, highestSeverity, plainTextBody, summaryHeadline } from '../format.js';
import type { NotifyChannel, NotifyMessage } from '../types.js';

export type WebhookFormat = 'generic' | 'discord' | 'slack' | 'ntfy' | 'gotify';

export interface WebhookChannelOptions {
  url: string;
  format: WebhookFormat;
  /** Sent as `Authorization: Bearer <token>` (ntfy/gotify style) -- never logged. */
  token?: string | undefined;
  /** Aborts the request after this many ms. Default 10s (see the ticket). */
  timeoutMs?: number;
  /** Overridable for tests; defaults to the global `fetch` (undici, under Node >= 18). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** Discord hard-caps message content at 2000 chars; the ticket asks for 1900 to leave headroom. */
const DISCORD_MAX_CONTENT = 1900;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Gotify priority (0-10 scale): `error` alerts page loudly, `warning` is a normal notice,
 *  anything else (a resolve/clear/summary-only batch) is low-priority background info. */
function gotifyPriority(message: NotifyMessage): number {
  const severity = highestSeverity(message);
  if (severity === 'error') return 8;
  if (severity === 'warning') return 4;
  return 2;
}

/** ntfy priority string (its own 1-5 + name scale). */
function ntfyPriority(message: NotifyMessage): 'urgent' | 'high' | 'default' {
  const severity = highestSeverity(message);
  if (severity === 'error') return 'urgent';
  if (severity === 'warning') return 'high';
  return 'default';
}

function ntfyTags(message: NotifyMessage): string {
  const severity = highestSeverity(message);
  if (severity === 'error') return 'rotating_light';
  if (severity === 'warning') return 'warning';
  return 'information_source';
}

/** Builds this format's request body + any extra headers beyond `content-type`/`Authorization`
 *  (both applied by `send` itself). */
function buildRequest(
  format: WebhookFormat,
  message: NotifyMessage,
  siteName: string,
): { body: string; contentType: string; headers?: Record<string, string> } {
  switch (format) {
    case 'generic':
      return {
        contentType: 'application/json',
        body: JSON.stringify({
          site: siteName,
          summary: summaryHeadline(message),
          events: message.events.map((event) => ({
            type: event.type,
            severity: event.severity,
            kind: event.kind,
            title: event.title,
            detail: event.detail,
            node: event.node,
            vmid: event.vmid,
            at: event.at,
            url: event.url,
          })),
        }),
      };
    case 'discord': {
      const text = `**${siteName}** — ${plainTextBody(message)}`;
      return { contentType: 'application/json', body: JSON.stringify({ content: truncate(text, DISCORD_MAX_CONTENT) }) };
    }
    case 'slack':
      return {
        contentType: 'application/json',
        body: JSON.stringify({ text: `*${siteName}* — ${plainTextBody(message)}` }),
      };
    case 'ntfy':
      return {
        contentType: 'text/plain; charset=utf-8',
        body: message.events.map(eventLine).join('\n') || summaryHeadline(message),
        headers: {
          Title: `${siteName}: ${summaryHeadline(message)}`,
          Priority: ntfyPriority(message),
          Tags: ntfyTags(message),
        },
      };
    case 'gotify':
      return {
        contentType: 'application/json',
        body: JSON.stringify({
          title: `${siteName}: ${summaryHeadline(message)}`,
          message: plainTextBody(message),
          priority: gotifyPriority(message),
        }),
      };
  }
}

/**
 * The webhook notification channel: one HTTP POST per message, in one of five shapes selected by
 * `PROXION_NOTIFY_WEBHOOK_FORMAT`. Throws on a non-2xx response, a network error, or a timeout --
 * `Notifier` is the one place that catches, logs and retries that.
 */
export function createWebhookChannel(options: WebhookChannelOptions): NotifyChannel {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  // Computed once at creation, not per-request -- this is the one thing about the webhook that's
  // safe to log (see `NotifyChannel.host`'s doc comment). An invalid URL can't reach here: config.ts
  // already validated it as an absolute http(s) URL before a channel is ever constructed.
  const host = new URL(options.url).host;

  return {
    name: 'webhook',
    host,
    async send(message: NotifyMessage): Promise<void> {
      const { body, contentType, headers } = buildRequest(options.format, message, message.siteName);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(options.url, {
          method: 'POST',
          headers: {
            'content-type': contentType,
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
            ...headers,
          },
          body,
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`webhook responded ${res.status} ${res.statusText}`);
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`webhook request to ${host} timed out after ${timeoutMs}ms`, { cause: error });
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
