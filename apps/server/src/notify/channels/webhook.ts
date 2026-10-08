import {
  escapeSlackMrkdwn,
  eventGlyph,
  eventGlyphShortcode,
  eventMeta,
  highestSeverity,
  isoWhen,
  markdownBody,
  primaryEvent,
  safeUrl,
  severityColorHex,
  severityColorInt,
  summaryHeadline,
  typeLabel,
} from '../format.js';
import type { NotifyChannel, NotifyEvent, NotifyMessage } from '../types.js';

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
/** Discord rejects a message with more than 10 embeds, so the "...and N more" overflow embed
 *  counts towards the cap: 10 events are shown as-is, 11+ become 9 events + the overflow embed. */
const DISCORD_MAX_EMBEDS = 10;
const DISCORD_MAX_TITLE = 256;
const DISCORD_MAX_DESCRIPTION = 4096;
const DISCORD_MAX_FIELD_VALUE = 1024;
const DISCORD_MAX_USERNAME = 80;
/** Discord's cap on the combined text of every embed in one message is 6000; leave headroom. */
const DISCORD_TOTAL_BUDGET = 5800;
const DISCORD_OVERFLOW_COLOR = 0x64748b;
/** Slack allows 50 blocks per message. Header + 3 blocks per event + the overflow context is 50
 *  at 16 events, so that is the cap (a 20-event cap would be rejected as invalid_blocks). */
const SLACK_MAX_EVENTS = 16;
const SLACK_MAX_HEADER = 150;
const SLACK_MAX_SECTION = 3000;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Like `truncate`, but never leaves half of an `&amp;`/`&lt;`/`&gt;` entity at the cut. */
function truncateEscaped(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).replace(/&[a-z]{0,3}$/, '')}…`;
}

/** ntfy rejects non-ASCII (and control characters) in header values -- drop them. */
function asciiHeader(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '').trim();
}

interface DiscordEmbed {
  title: string;
  description?: string;
  url?: string;
  color: number;
  timestamp?: string;
  fields?: { name: string; value: string; inline: boolean }[];
  footer?: { text: string };
}

function discordEmbed(event: NotifyEvent, siteName: string): DiscordEmbed {
  const meta = eventMeta(event, { includeWhen: false });
  const timestamp = isoWhen(event.at);
  const url = safeUrl(event.url);
  return {
    title: truncate(`${eventGlyph(event)} ${typeLabel(event.type)} · ${event.title}`, DISCORD_MAX_TITLE),
    ...(event.detail ? { description: truncate(event.detail, DISCORD_MAX_DESCRIPTION) } : {}),
    ...(url ? { url } : {}),
    color: severityColorInt(event),
    ...(timestamp ? { timestamp } : {}),
    ...(meta
      ? { fields: [{ name: 'Where', value: truncate(meta, DISCORD_MAX_FIELD_VALUE), inline: true }] }
      : {}),
    footer: { text: truncate(siteName, 2048) },
  };
}

function discordEmbedSize(embed: DiscordEmbed): number {
  return (
    embed.title.length +
    (embed.description?.length ?? 0) +
    (embed.footer?.text.length ?? 0) +
    (embed.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0)
  );
}

/** Shrinks the embeds until their combined text fits Discord's 6000-character total: descriptions
 *  are shared out of whatever the fixed parts leave, then (pathological inputs only) fields and
 *  footers go, then titles are cut hard. */
function fitDiscordBudget(embeds: DiscordEmbed[]): void {
  const total = (): number => embeds.reduce((sum, embed) => sum + discordEmbedSize(embed), 0);
  if (total() <= DISCORD_TOTAL_BUDGET) return;

  const withDescription = embeds.filter((embed) => embed.description);
  const fixed = total() - withDescription.reduce((sum, embed) => sum + (embed.description?.length ?? 0), 0);
  if (withDescription.length > 0) {
    const share = Math.max(0, Math.floor((DISCORD_TOTAL_BUDGET - fixed) / withDescription.length));
    for (const embed of withDescription) {
      if (share < 2) delete embed.description;
      else embed.description = truncate(embed.description ?? '', share);
    }
  }
  if (total() <= DISCORD_TOTAL_BUDGET) return;

  for (const embed of embeds) {
    delete embed.fields;
    delete embed.footer;
  }
  if (total() <= DISCORD_TOTAL_BUDGET) return;
  for (const embed of embeds) embed.title = truncate(embed.title, 100);
}

function discordPayload(message: NotifyMessage, siteName: string): unknown {
  const events = message.events;
  const overflow = events.length > DISCORD_MAX_EMBEDS;
  const shown = overflow ? events.slice(0, DISCORD_MAX_EMBEDS - 1) : events;
  const embeds = shown.map((event) => discordEmbed(event, siteName));
  if (overflow) {
    embeds.push({ title: `…and ${events.length - shown.length} more`, color: DISCORD_OVERFLOW_COLOR });
  }
  fitDiscordBudget(embeds);
  return {
    username: truncate(siteName, DISCORD_MAX_USERNAME),
    content: truncate(summaryHeadline(message), DISCORD_MAX_CONTENT),
    embeds,
  };
}

/** `<url|title>` link text for Slack mrkdwn -- the URL may not contain `<`, `>` or `|`. */
function slackLink(url: string, text: string): string {
  const safe = url.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/\|/g, '%7C');
  return `<${safe}|${text}>`;
}

function slackSection(event: NotifyEvent): unknown {
  const url = safeUrl(event.url);
  const title = truncateEscaped(escapeSlackMrkdwn(event.title), 600);
  const head = `*${typeLabel(event.type)}* ${url ? slackLink(url, title) : title}`;
  let text = head;
  if (event.detail) {
    const room = SLACK_MAX_SECTION - head.length - 1;
    if (room > 1) text = `${head}\n${truncateEscaped(escapeSlackMrkdwn(event.detail), room)}`;
  }
  return { type: 'section', text: { type: 'mrkdwn', text: truncate(text, SLACK_MAX_SECTION) } };
}

function slackPayload(message: NotifyMessage, siteName: string): unknown {
  const headline = summaryHeadline(message);
  const lead = primaryEvent(message);
  const glyph = lead ? eventGlyph(lead) : 'ℹ️';
  const events = message.events;
  const shown = events.slice(0, SLACK_MAX_EVENTS);

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: truncate(`${glyph} ${siteName}: ${headline}`, SLACK_MAX_HEADER), emoji: true },
    },
  ];
  for (const event of shown) {
    blocks.push(slackSection(event));
    const meta = eventMeta(event);
    if (meta) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: escapeSlackMrkdwn(meta) }] });
    blocks.push({ type: 'divider' });
  }
  if (events.length > shown.length) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `…and ${events.length - shown.length} more` }],
    });
  }
  return { text: escapeSlackMrkdwn(`${siteName} — ${headline}`), blocks };
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

/** The glyph shortcode of the highest-severity event, plus `computer` when any event is about a
 *  guest (has a vmid). */
function ntfyTags(message: NotifyMessage): string {
  const lead = primaryEvent(message);
  const tags = [lead ? eventGlyphShortcode(lead) : 'information_source'];
  if (message.events.some((event) => event.vmid)) tags.push('computer');
  return tags.join(',');
}

function firstUrl(message: NotifyMessage): string | undefined {
  for (const event of message.events) {
    const url = safeUrl(event.url);
    if (url) return url;
  }
  return undefined;
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
          headline: summaryHeadline(message),
          highestSeverity: highestSeverity(message),
          sentAt: new Date().toISOString(),
          events: message.events.map((event) => ({
            type: event.type,
            severity: event.severity,
            kind: event.kind,
            title: event.title,
            detail: event.detail,
            node: event.node,
            vmid: event.vmid,
            guestName: event.guestName,
            guestType: event.guestType,
            label: typeLabel(event.type),
            color: severityColorHex(event),
            at: event.at,
            url: event.url,
          })),
        }),
      };
    case 'discord':
      return { contentType: 'application/json', body: JSON.stringify(discordPayload(message, siteName)) };
    case 'slack':
      return { contentType: 'application/json', body: JSON.stringify(slackPayload(message, siteName)) };
    case 'ntfy': {
      const click = firstUrl(message);
      return {
        contentType: 'text/plain; charset=utf-8',
        body: markdownBody(message),
        headers: {
          Title: asciiHeader(`${siteName}: ${summaryHeadline(message)}`),
          Priority: ntfyPriority(message),
          Tags: ntfyTags(message),
          Markdown: 'yes',
          ...(click
            ? {
                Click: asciiHeader(click),
                // `Actions` is comma/semicolon-delimited, so those must not appear raw in the url.
                Actions: asciiHeader(
                  `view, Open in Proxion, ${click.replace(/,/g, '%2C').replace(/;/g, '%3B')}, clear=true`,
                ),
              }
            : {}),
        },
      };
    }
    case 'gotify': {
      const click = firstUrl(message);
      return {
        contentType: 'application/json',
        body: JSON.stringify({
          title: `${siteName}: ${summaryHeadline(message)}`,
          message: markdownBody(message),
          priority: gotifyPriority(message),
          extras: {
            'client::display': { contentType: 'text/markdown' },
            ...(click ? { 'client::notification': { click: { url: click } } } : {}),
          },
        }),
      };
    }
  }
}

/**
 * A failed webhook delivery, reduced to what is safe to show to a signed-in operator: the kind of
 * failure and (for `http`) the status code. Never the host, URL, status text, redirect target or
 * response body -- the test endpoint must not double as a port scanner or an internal-service
 * oracle (see `notifier.ts`'s `sanitiseTestError`).
 */
export class WebhookSendError extends Error {
  constructor(
    readonly kind: 'http' | 'timeout' | 'network',
    readonly status?: number,
  ) {
    super(kind === 'http' ? `webhook responded HTTP ${status}` : `webhook request failed (${kind})`);
    this.name = 'WebhookSendError';
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
          // Never follow a redirect: a 3xx from the configured address must not move the request
          // (and its bearer token) somewhere the operator did not choose.
          redirect: 'error',
        });
        if (!res.ok) throw new WebhookSendError('http', res.status);
      } catch (error) {
        if (error instanceof WebhookSendError) throw error;
        // Deliberately no `cause`: undici's error causes carry the target address.
        if (error instanceof Error && error.name === 'AbortError') throw new WebhookSendError('timeout');
        throw new WebhookSendError('network');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
