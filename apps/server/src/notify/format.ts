import type { ResourceLike } from '@proxion/core';
import type { NotifyEvent, NotifyEventType, NotifyMessage } from './types.js';

/** Order matters only between `warning`/`error` -- `healed` is never compared against the
 *  threshold (a heal is announced via `PROXION_NOTIFY_INCLUDE_RESOLVED`, not min-severity). */
export function severityRank(severity: 'warning' | 'error'): number {
  return severity === 'error' ? 2 : 1;
}

const TYPE_LABEL: Record<NotifyEventType, string> = {
  opened: 'NEW',
  resolved: 'RESOLVED',
  cleared: 'CLEARED',
  escalated: 'ESCALATED',
  'summary-item': 'CURRENT',
  test: 'TEST',
};

/** The short upper-case label for an event type (NEW / ESCALATED / RESOLVED / CLEARED / CURRENT /
 *  TEST) -- the chip in the email, the bold prefix everywhere else. */
export function typeLabel(type: NotifyEventType): string {
  return TYPE_LABEL[type];
}

/** Finds the guest type (`qemu`/`lxc`) for a vmid in a `/cluster/resources` snapshot, for
 *  building a deep link -- `undefined` when the vmid isn't a guest resource at all (e.g. it was
 *  already removed) or the resources snapshot doesn't have it yet. */
export function resolveGuestType(
  resources: readonly ResourceLike[],
  vmid: string,
): 'qemu' | 'lxc' | undefined {
  const numericVmid = Number(vmid);
  for (const resource of resources) {
    if (
      (resource.type === 'qemu' || resource.type === 'lxc') &&
      resource.vmid !== undefined &&
      resource.vmid === numericVmid
    ) {
      return resource.type;
    }
  }
  return undefined;
}

/**
 * `<url>/vm/<node>/<type>/<vmid>?tab=summary` for a guest alert (one with both `node` and `vmid`,
 * and a resolvable guest type), `<url>/` otherwise (a storage alert, or a guest whose type isn't
 * known any more) -- `undefined` entirely when no `PROXION_PUBLIC_URL` is configured.
 */
export function buildDeepLink(
  alert: { node?: string | undefined; vmid?: string | undefined },
  publicUrl: string | undefined,
  resources: readonly ResourceLike[],
): string | undefined {
  if (!publicUrl) return undefined;
  const base = publicUrl.replace(/\/+$/, '');
  if (alert.node && alert.vmid) {
    const type = resolveGuestType(resources, alert.vmid);
    if (type) return `${base}/vm/${alert.node}/${type}/${alert.vmid}?tab=summary`;
  }
  return `${base}/`;
}

/** One human-readable line for an event -- shared by every text-based channel format (Discord,
 *  Slack, ntfy, and the email plain-text body). */
export function eventLine(event: NotifyEvent): string {
  const label = typeLabel(event.type);
  const parts = [`[${label}] ${event.title}`];
  if (event.detail) parts.push(event.detail);
  if (event.url) parts.push(event.url);
  return parts.join(' — ');
}

/** The message's headline, e.g. "3 alert(s) opened, 1 resolved" -- used by every channel that
 *  wants a one-line summary (Discord/Slack/ntfy Title/email subject). */
export function summaryHeadline(message: NotifyMessage): string {
  if (message.kind === 'test') return 'Test notification - these are sample alerts';
  if (message.kind === 'summary') {
    return message.events.length === 0
      ? 'Proxion notifications are active; no current alerts'
      : `Proxion notifications are active; ${message.events.length} current alert(s)`;
  }

  const counts = new Map<NotifyEventType, number>();
  for (const event of message.events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  const bits: string[] = [];
  for (const type of ['opened', 'escalated', 'resolved', 'cleared'] as const) {
    const count = counts.get(type);
    if (count) bits.push(`${count} ${type}`);
  }
  return bits.length > 0 ? `${bits.join(', ')}` : `${message.events.length} update(s)`;
}

/** Full plain-text body: headline, then one line per event. Shared by ntfy's body and the email
 *  channel's plain-text body. */
export function plainTextBody(message: NotifyMessage): string {
  const lines = message.events.map(eventLine);
  return [summaryHeadline(message), ...lines].join('\n');
}

/** The single highest severity across a message's events, for channels that pick one
 *  priority/color for the whole message (ntfy's `Priority` header, Gotify's `priority`). Treats
 *  `healed`/no-events as the lowest priority. */
export function highestSeverity(message: NotifyMessage): 'error' | 'warning' | 'healed' {
  let highest: 'error' | 'warning' | 'healed' = 'healed';
  for (const event of message.events) {
    if (event.severity === 'error') return 'error';
    if (event.severity === 'warning') highest = 'warning';
  }
  return highest;
}

// ---------------------------------------------------------------------------------------------
// Rich formatting helpers -- pure; shared by the email HTML body and every webhook format.
// ---------------------------------------------------------------------------------------------

/** Finds a guest's display name (`web-prod-01`) for a vmid in a `/cluster/resources` snapshot --
 *  `undefined` when the guest is gone, never throws. */
export function resolveGuestName(resources: readonly ResourceLike[], vmid: string): string | undefined {
  const numericVmid = Number(vmid);
  for (const resource of resources) {
    if (
      (resource.type === 'qemu' || resource.type === 'lxc') &&
      resource.vmid !== undefined &&
      resource.vmid === numericVmid &&
      typeof resource.name === 'string' &&
      resource.name !== ''
    ) {
      return resource.name;
    }
  }
  return undefined;
}

/** Fills in `guestName`/`guestType` on an event from the resources snapshot (a no-op for an event
 *  with no vmid, or one whose guest is no longer in the snapshot). Never throws. */
export function enrichEvent(event: NotifyEvent, resources: readonly ResourceLike[]): NotifyEvent {
  if (!event.vmid) return event;
  const guestName = resolveGuestName(resources, event.vmid);
  const guestType = resolveGuestType(resources, event.vmid);
  if (guestName === undefined && guestType === undefined) return event;
  return { ...event, guestName, guestType };
}

/** One emoji per (type, severity): opened+error red circle, opened+warning orange circle,
 *  escalated red triangle, resolved/cleared check mark, summary-item info, test tube. */
export function eventGlyph(event: Pick<NotifyEvent, 'type' | 'severity'>): string {
  switch (event.type) {
    case 'test':
      return '🧪';
    case 'resolved':
    case 'cleared':
      return '✅';
    case 'escalated':
      return '🔺';
    case 'summary-item':
      return 'ℹ️';
    case 'opened':
      if (event.severity === 'error') return '🔴';
      if (event.severity === 'warning') return '🟠';
      return '✅';
  }
}

/** The ntfy `Tags` shortcode matching `eventGlyph` (ntfy renders these as emoji itself, which keeps
 *  the header ASCII). */
export function eventGlyphShortcode(event: Pick<NotifyEvent, 'type' | 'severity'>): string {
  switch (event.type) {
    case 'test':
      return 'test_tube';
    case 'resolved':
    case 'cleared':
      return 'white_check_mark';
    case 'escalated':
      return 'small_red_triangle';
    case 'summary-item':
      return 'information_source';
    case 'opened':
      if (event.severity === 'error') return 'red_circle';
      if (event.severity === 'warning') return 'large_orange_circle';
      return 'white_check_mark';
  }
}

export const COLOR_ERROR = '#DC2626';
export const COLOR_WARNING = '#D97706';
export const COLOR_OK = '#16A34A';
export const COLOR_TEST = '#2563EB';

/** Accent colour for an event: test blue, resolved/cleared/healed green, error red, warning amber. */
export function severityColorHex(event: Pick<NotifyEvent, 'type' | 'severity'>): string {
  if (event.type === 'test') return COLOR_TEST;
  if (event.type === 'resolved' || event.type === 'cleared' || event.severity === 'healed') return COLOR_OK;
  return event.severity === 'error' ? COLOR_ERROR : COLOR_WARNING;
}

/** `severityColorHex` as the decimal integer Discord embeds want. */
export function severityColorInt(event: Pick<NotifyEvent, 'type' | 'severity'>): number {
  return Number.parseInt(severityColorHex(event).slice(1), 16);
}

/** `2026-10-06 15:58 UTC` -- always UTC (the container has no local zone); empty for a value that
 *  isn't a valid epoch-seconds timestamp. */
export function formatWhen(atSeconds: number): string {
  const date = new Date(atSeconds * 1000);
  if (!Number.isFinite(date.getTime())) return '';
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** ISO-8601 for `at` (epoch seconds), `undefined` when it isn't a valid timestamp. */
export function isoWhen(atSeconds: number): string | undefined {
  const date = new Date(atSeconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** `web-prod-01 (VM 100)` / `VM 100` / `CT 200` / `Guest 100`; `undefined` for a non-guest event. */
function guestLabel(event: NotifyEvent): string | undefined {
  const kind = event.guestType === 'qemu' ? 'VM' : event.guestType === 'lxc' ? 'CT' : undefined;
  const id = [kind, event.vmid].filter((part): part is string => !!part).join(' ');
  if (event.guestName) return id ? `${event.guestName} (${id})` : event.guestName;
  if (event.vmid) return kind ? id : `Guest ${event.vmid}`;
  return undefined;
}

/** `node · guest (VM 100 / CT 200) · when`, joining only the parts present. Pass
 *  `{ includeWhen: false }` for the "Where" field of a Discord embed (which has its own timestamp). */
export function eventMeta(event: NotifyEvent, options: { includeWhen?: boolean } = {}): string {
  const parts: string[] = [];
  if (event.node) parts.push(event.node);
  const guest = guestLabel(event);
  if (guest) parts.push(guest);
  if (options.includeWhen !== false) {
    const when = formatWhen(event.at);
    if (when) parts.push(when);
  }
  return parts.join(' · ');
}

const MAX_SUBJECT_LENGTH = 120;

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The email subject: `[site] headline — first event title` (truncated to 120 chars) for
 *  transitions, a fixed line for test/summary messages. */
export function subjectLine(message: NotifyMessage): string {
  const prefix = `[${message.siteName}]`;
  if (message.kind === 'test') return singleLine(`${prefix} Test notification`);
  if (message.kind === 'summary') return singleLine(`${prefix} Notifications are active`);
  const first = message.events[0]?.title;
  const text = singleLine(`${prefix} ${summaryHeadline(message)}${first ? ` — ${first}` : ''}`);
  return text.length <= MAX_SUBJECT_LENGTH ? text : `${text.slice(0, MAX_SUBJECT_LENGTH - 1)}…`;
}

/** Escapes text for an HTML text node or a double-/single-quoted attribute value. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escapes the three characters Slack's mrkdwn treats as control characters. */
export function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Backslash-escapes characters that would start Markdown emphasis, links or HTML in user-controlled
 *  text (ntfy/Gotify render Markdown). */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>]/g, '\\$&');
}

/** The event whose severity decides a whole message's glyph/tag: the first `error` event, else the
 *  first `warning`, else the first event; `undefined` when there are none. */
export function primaryEvent(message: NotifyMessage): NotifyEvent | undefined {
  return (
    message.events.find((event) => event.severity === 'error') ??
    message.events.find((event) => event.severity === 'warning') ??
    message.events[0]
  );
}

/** Only absolute http(s) URLs are ever put in a link -- anything else is dropped. */
export function safeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Markdown body for ntfy / Gotify: one `- **NEW** title — node · guest · when — [Open](url)` bullet
 *  per event, the detail (if any) on an indented continuation line. The headline when there are no
 *  events (e.g. the first-run "no current alerts" summary). */
export function markdownBody(message: NotifyMessage): string {
  if (message.events.length === 0) return summaryHeadline(message);
  return message.events
    .map((event) => {
      const tail: string[] = [];
      const meta = eventMeta(event);
      if (meta) tail.push(escapeMarkdown(singleLine(meta)));
      const url = safeUrl(event.url);
      if (url) tail.push(`[Open](${url.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20')})`);
      const line = `- **${typeLabel(event.type)}** ${escapeMarkdown(singleLine(event.title))}${tail.length > 0 ? ` — ${tail.join(' — ')}` : ''}`;
      const detail = event.detail ? singleLine(event.detail) : '';
      return detail ? `${line}\n  ${escapeMarkdown(detail)}` : line;
    })
    .join('\n');
}

const MAX_HTML_CARDS = 25;
const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const INK = '#0F172A';
const MUTED = '#475569';
const MUTED_SOFT = '#64748B';

function htmlButton(href: string, color: string): string {
  const url = escapeHtml(href);
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;"><tr><td>` +
    `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:44px;v-text-anchor:middle;width:220px;" arcsize="14%" stroke="f" fillcolor="${color}"><w:anchorlock/><center style="color:#ffffff;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;font-weight:600;line-height:44px;mso-line-height-rule:exactly;white-space:nowrap;">Open in Proxion</center></v:roundrect><![endif]-->` +
    `<!--[if !mso]><!-->` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${color}" style="background-color:${color};border-radius:6px;">` +
    `<a href="${url}" style="display:inline-block;padding:12px 24px;font-family:${FONT_STACK};font-size:14px;font-weight:600;line-height:20px;color:#ffffff;text-decoration:none;white-space:nowrap;mso-padding-alt:0;">Open in Proxion</a>` +
    `</td></tr></table>` +
    `<!--<![endif]-->` +
    `</td></tr></table>`
  );
}

function htmlCard(event: NotifyEvent): string {
  const color = severityColorHex(event);
  const meta = eventMeta(event);
  const url = safeUrl(event.url);
  return (
    `<tr><td style="padding:0 24px 12px 24px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border:1px solid #E2E8F0;border-left:4px solid ${color};border-radius:6px;">` +
    `<tr><td style="padding:16px 18px;font-family:${FONT_STACK};">` +
    `<span style="display:inline-block;padding:2px 8px;border:1px solid ${color};border-radius:4px;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${color};">${escapeHtml(typeLabel(event.type))}</span>` +
    `<div style="margin-top:10px;font-size:16px;line-height:22px;font-weight:600;color:${INK};">${escapeHtml(event.title)}</div>` +
    (event.detail
      ? `<div style="margin-top:4px;font-size:14px;line-height:20px;color:${MUTED};">${escapeHtml(event.detail)}</div>`
      : '') +
    (meta
      ? `<div style="margin-top:8px;font-size:12px;line-height:18px;color:${MUTED_SOFT};">${escapeHtml(meta)}</div>`
      : '') +
    (url ? htmlButton(url, color) : '') +
    `</td></tr></table></td></tr>`
  );
}

/** An email-client-safe HTML document for a notification: 600 px centred table, inline styles only
 *  (no external CSS/images/scripts), a slate header, one card per event with a severity-coloured
 *  edge, and a bulletproof "Open in Proxion" button (plus a VML fallback for Outlook) on every card
 *  whose event has a link. Light theme only. Every user-controlled string goes through
 *  `escapeHtml`. */
export function htmlBody(message: NotifyMessage): string {
  const site = escapeHtml(message.siteName);
  const headline = escapeHtml(summaryHeadline(message));
  const shown = message.events.slice(0, MAX_HTML_CARDS);
  const hidden = message.events.length - shown.length;

  const cards =
    message.events.length === 0
      ? `<tr><td style="padding:0 24px 12px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border:1px solid #E2E8F0;border-left:4px solid ${COLOR_OK};border-radius:6px;"><tr><td style="padding:16px 18px;font-family:${FONT_STACK};font-size:14px;line-height:20px;color:${MUTED};">No current alerts.</td></tr></table></td></tr>`
      : shown.map(htmlCard).join('');
  const more =
    hidden > 0
      ? `<tr><td style="padding:0 24px 12px 24px;font-family:${FONT_STACK};font-size:13px;color:${MUTED_SOFT};">…and ${hidden} more</td></tr>`
      : '';

  const firstUrl = message.events.map((event) => safeUrl(event.url)).find((url) => url !== undefined);
  const origin = firstUrl ? new URL(firstUrl).origin : undefined;
  const sentBy =
    message.siteName.trim().toLowerCase() === 'proxion' ? 'Sent by Proxion' : `Sent by Proxion · ${site}`;
  const footer = origin
    ? `<a href="${escapeHtml(origin)}" style="color:${MUTED_SOFT};text-decoration:underline;">${sentBy}</a>`
    : sentBy;

  return (
    `<!DOCTYPE html>` +
    `<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">` +
    // Outlook (Word engine) at 120/144 DPI scales text but not VML/px widths unless told to lay out
    // at 96 DPI -- without this the button text overflows its VML box (seen on Chris's Outlook).
    `<!--[if mso]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->` +
    `<title>${site}: ${headline}</title></head>` +
    `<body style="margin:0;padding:0;background-color:#F1F5F9;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F1F5F9;"><tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">` +
    `<tr><td style="background-color:#0F172A;padding:20px 24px;border-radius:8px 8px 0 0;font-family:${FONT_STACK};">` +
    `<div style="font-size:18px;line-height:24px;font-weight:700;color:#ffffff;">${site}</div>` +
    `<div style="margin-top:2px;font-size:14px;line-height:20px;font-weight:400;color:#CBD5E1;">${headline}</div>` +
    `</td></tr>` +
    `<tr><td style="font-size:0;line-height:16px;height:16px;">&nbsp;</td></tr>` +
    cards +
    more +
    `<tr><td style="padding:12px 24px 0 24px;font-family:${FONT_STACK};font-size:12px;line-height:18px;color:${MUTED_SOFT};text-align:center;">${footer}</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}
