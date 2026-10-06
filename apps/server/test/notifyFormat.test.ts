import nodemailer from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';
import { createEmailChannel } from '../src/notify/channels/email.js';
import { createWebhookChannel, type WebhookFormat } from '../src/notify/channels/webhook.js';
import {
  enrichEvent,
  escapeHtml,
  escapeSlackMrkdwn,
  eventGlyph,
  eventGlyphShortcode,
  eventMeta,
  formatWhen,
  htmlBody,
  markdownBody,
  resolveGuestName,
  severityColorHex,
  severityColorInt,
  subjectLine,
  typeLabel,
} from '../src/notify/format.js';
import type { NotifyEvent, NotifyEventType, NotifyMessage } from '../src/notify/types.js';

// 2026-10-06 15:58:00 UTC
const AT = 1_791_302_280;
const URL_VM = 'https://proxion.example.com/vm/c2dc2/qemu/100?tab=summary';

function ev(overrides: Partial<NotifyEvent> = {}): NotifyEvent {
  return { type: 'opened', severity: 'error', kind: 'backup', title: 'Backup failed', at: AT, ...overrides };
}

function msg(events: NotifyEvent[], overrides: Partial<NotifyMessage> = {}): NotifyMessage {
  return { kind: 'transitions', siteName: 'Proxion', events, ...overrides };
}

const GUEST_EVENT = ev({
  title: 'Backup of web-prod-01 (VM 100) failed on c2dc2',
  detail: 'vzdump exited with status 1',
  node: 'c2dc2',
  vmid: '100',
  guestName: 'web-prod-01',
  guestType: 'qemu',
  url: URL_VM,
});

describe('format helpers', () => {
  it('typeLabel maps every event type', () => {
    const expected: Record<NotifyEventType, string> = {
      opened: 'NEW',
      escalated: 'ESCALATED',
      resolved: 'RESOLVED',
      cleared: 'CLEARED',
      'summary-item': 'CURRENT',
      test: 'TEST',
    };
    for (const [type, label] of Object.entries(expected)) {
      expect(typeLabel(type as NotifyEventType)).toBe(label);
    }
  });

  it('eventGlyph / eventGlyphShortcode cover each (type, severity) combination', () => {
    const cases: [Partial<NotifyEvent>, string, string][] = [
      [{ type: 'opened', severity: 'error' }, '🔴', 'red_circle'],
      [{ type: 'opened', severity: 'warning' }, '🟠', 'large_orange_circle'],
      [{ type: 'escalated', severity: 'error' }, '🔺', 'small_red_triangle'],
      [{ type: 'resolved', severity: 'healed' }, '✅', 'white_check_mark'],
      [{ type: 'cleared', severity: 'error' }, '✅', 'white_check_mark'],
      [{ type: 'summary-item', severity: 'warning' }, 'ℹ️', 'information_source'],
      [{ type: 'test', severity: 'warning' }, '🧪', 'test_tube'],
    ];
    for (const [overrides, glyph, shortcode] of cases) {
      expect(eventGlyph(ev(overrides))).toBe(glyph);
      expect(eventGlyphShortcode(ev(overrides))).toBe(shortcode);
    }
  });

  it('severityColorHex / severityColorInt: error red, warning amber, healed green, test blue', () => {
    expect(severityColorHex(ev({ severity: 'error' }))).toBe('#DC2626');
    expect(severityColorHex(ev({ severity: 'warning' }))).toBe('#D97706');
    expect(severityColorHex(ev({ type: 'resolved', severity: 'healed' }))).toBe('#16A34A');
    expect(severityColorHex(ev({ type: 'cleared', severity: 'error' }))).toBe('#16A34A');
    expect(severityColorHex(ev({ type: 'test', severity: 'warning' }))).toBe('#2563EB');
    expect(severityColorInt(ev({ severity: 'error' }))).toBe(0xdc2626);
    expect(severityColorInt(ev({ severity: 'warning' }))).toBe(14_251_782); // 0xD97706
    expect(severityColorInt(ev({ type: 'resolved', severity: 'healed' }))).toBe(0x16a34a);
    expect(severityColorInt(ev({ type: 'test' }))).toBe(0x2563eb);
  });

  it('formatWhen renders UTC regardless of the local zone, and is empty for a bad timestamp', () => {
    expect(formatWhen(AT)).toBe('2026-10-06 15:58 UTC');
    expect(formatWhen(0)).toBe('1970-01-01 00:00 UTC');
    expect(formatWhen(Number.NaN)).toBe('');
  });

  it('eventMeta joins only the parts present', () => {
    expect(eventMeta(GUEST_EVENT)).toBe('c2dc2 · web-prod-01 (VM 100) · 2026-10-06 15:58 UTC');
    expect(eventMeta(GUEST_EVENT, { includeWhen: false })).toBe('c2dc2 · web-prod-01 (VM 100)');
    expect(eventMeta(ev({ node: 'c2dc2', vmid: '200', guestName: 'db', guestType: 'lxc' }))).toBe(
      'c2dc2 · db (CT 200) · 2026-10-06 15:58 UTC',
    );
    // No guest: the guest part is omitted entirely.
    expect(eventMeta(ev({ node: 'c2dc2' }))).toBe('c2dc2 · 2026-10-06 15:58 UTC');
    // A vmid whose guest has gone (no name/type) still shows the id.
    expect(eventMeta(ev({ node: 'c2dc2', vmid: '999' }))).toBe('c2dc2 · Guest 999 · 2026-10-06 15:58 UTC');
    expect(eventMeta(ev({ at: Number.NaN }))).toBe('');
  });

  describe('subjectLine', () => {
    it('transitions: [site] headline — first title', () => {
      expect(subjectLine(msg([ev({ title: 'Backup failed' }), ev({ type: 'resolved', title: 'Other' })]))).toBe(
        '[Proxion] 1 opened, 1 resolved — Backup failed',
      );
    });

    it('truncates to 120 characters with an ellipsis', () => {
      const subject = subjectLine(msg([ev({ title: 'x'.repeat(300) })]));
      expect(subject).toHaveLength(120);
      expect(subject.endsWith('…')).toBe(true);
      expect(subject.startsWith('[Proxion] 1 opened — xxx')).toBe(true);
    });

    it('collapses newlines so the header stays on one line', () => {
      expect(subjectLine(msg([ev({ title: 'a\r\nBcc: x@y.z' })]))).not.toMatch(/[\r\n]/);
    });

    it('test and summary messages get fixed subjects', () => {
      expect(subjectLine(msg([ev()], { kind: 'test' }))).toBe('[Proxion] Test notification');
      expect(subjectLine(msg([], { kind: 'summary' }))).toBe('[Proxion] Notifications are active');
    });
  });

  it('escapeHtml escapes & < > " \'', () => {
    expect(escapeHtml('<script>&"\'')).toBe('&lt;script&gt;&amp;&quot;&#39;');
    expect(escapeHtml('plain')).toBe('plain');
  });

  it('escapeSlackMrkdwn escapes only & < >', () => {
    expect(escapeSlackMrkdwn('<script>&"')).toBe('&lt;script&gt;&amp;"');
  });

  describe('markdownBody', () => {
    it('renders one bullet per event with meta and an [Open](url) link', () => {
      const body = markdownBody(msg([GUEST_EVENT]));
      expect(body).toBe(
        `- **NEW** Backup of web-prod-01 (VM 100) failed on c2dc2 — c2dc2 · web-prod-01 (VM 100) · 2026-10-06 15:58 UTC — [Open](${URL_VM})\n  vzdump exited with status 1`,
      );
    });

    it('has no link when there is no url, and escapes markdown control characters in titles', () => {
      const body = markdownBody(msg([ev({ title: '*bold* [x](http://evil)', at: Number.NaN })]));
      expect(body).toBe('- **NEW** \\*bold\\* \\[x\\](http://evil)');
      expect(body).not.toContain('[Open]');
    });

    it('collapses newlines in titles, details and meta so one event is always one bullet', () => {
      const body = markdownBody(
        msg([ev({ title: 'x\r\n- **RESOLVED** forged', detail: 'd\n- **NEW** forged2', node: 'n\n- forged3' })]),
      );
      const bullets = body.split('\n').filter((line) => line.startsWith('- '));
      expect(bullets).toHaveLength(1);
      expect(body.split('\n')).toHaveLength(2); // the bullet + the single-line detail continuation
      expect(body.split('\n')[1]!.startsWith('  ')).toBe(true);
      expect(markdownBody(msg([ev({ title: 'x\r\n- **RESOLVED** forged', at: Number.NaN })])).split('\n')).toHaveLength(1);
    });

    it('falls back to the headline when there are no events', () => {
      expect(markdownBody(msg([], { kind: 'summary' }))).toBe('Proxion notifications are active; no current alerts');
    });
  });

  describe('htmlBody', () => {
    it('is an email-safe document with a slate header, severity-coloured card and Open button', () => {
      const html = htmlBody(msg([GUEST_EVENT], { siteName: 'Proxion Prod' }));
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).toContain('width="600"');
      expect(html).toContain('max-width:600px');
      expect(html).toContain('background-color:#0F172A'); // slate header
      expect(html).toContain('Proxion Prod');
      expect(html).toContain('border-left:4px solid #DC2626');
      expect(html).toContain('text-transform:uppercase');
      expect(html).toContain('>NEW</span>');
      expect(html).toContain('font-size:16px;line-height:22px;font-weight:600');
      expect(html).toContain('Backup of web-prod-01 (VM 100) failed on c2dc2');
      expect(html).toContain('vzdump exited with status 1');
      expect(html).toContain('c2dc2 · web-prod-01 (VM 100) · 2026-10-06 15:58 UTC');
      // Bulletproof button (table cell with the severity colour) + VML roundrect for Outlook.
      expect(html).toContain(`<td bgcolor="#DC2626" style="background-color:#DC2626;`);
      expect(html).toContain('<v:roundrect');
      expect(html).toContain(`href="${URL_VM}"`);
      expect(html).toContain('Open in Proxion');
      // Footer links to the url's origin.
      expect(html).toContain('<a href="https://proxion.example.com" style="color:#64748B;text-decoration:underline;">Sent by Proxion · Proxion Prod</a>');
    });

    it('is light-theme, inline-style only: no scripts, external CSS, images or style blocks', () => {
      const html = htmlBody(msg([GUEST_EVENT]));
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/<link/i);
      expect(html).not.toMatch(/<img/i);
      expect(html).not.toMatch(/<style/i);
      expect(html).not.toMatch(/@import|url\(/i);
    });

    it('escapes user-controlled strings everywhere (title, detail, site name, guest name, url)', () => {
      const html = htmlBody(
        msg(
          [
            ev({
              title: '<script>&"',
              detail: '<img src=x onerror=alert(1)>',
              node: '<n>',
              vmid: '1',
              guestName: '<b>vm</b>',
              guestType: 'lxc',
              url: 'https://proxion.example.com/?a="><script>',
            }),
          ],
          { siteName: '<Site>' },
        ),
      );
      expect(html).toContain('&lt;script&gt;&amp;&quot;');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).toContain('&lt;b&gt;vm&lt;/b&gt; (CT 1)');
      expect(html).toContain('&lt;Site&gt;');
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toContain('<img');
      expect(html).not.toContain('"><script>');
      expect(html).toContain('href="https://proxion.example.com/?a=&quot;&gt;&lt;script&gt;"');
    });

    it('has no button (and no footer link) when the event has no url, and drops non-http urls', () => {
      const html = htmlBody(msg([ev({ url: undefined }), ev({ url: 'javascript:alert(1)' })]));
      expect(html).not.toContain('Open in Proxion');
      expect(html).not.toContain('<v:roundrect');
      expect(html).not.toContain('javascript:');
      // Default site name: no redundant "· Proxion".
      expect(html).toContain('Sent by Proxion<');
      expect(html).not.toContain('Sent by Proxion ·');
      expect(html).not.toContain('<a href');
    });

    it('colours each card by its own event (resolved green, test blue, warning amber)', () => {
      const html = htmlBody(
        msg([
          ev({ type: 'resolved', severity: 'healed', title: 'R' }),
          ev({ type: 'escalated', severity: 'warning', title: 'W' }),
          ev({ type: 'test', title: 'T' }),
        ]),
      );
      expect(html).toContain('border-left:4px solid #16A34A');
      expect(html).toContain('border-left:4px solid #D97706');
      expect(html).toContain('border-left:4px solid #2563EB');
    });

    it('caps at 25 cards and appends "…and N more"', () => {
      const events = Array.from({ length: 30 }, (_, i) => ev({ title: `Event ${i}` }));
      const html = htmlBody(msg(events));
      expect(html.match(/border-left:4px solid #DC2626/g)).toHaveLength(25);
      expect(html).toContain('Event 24');
      expect(html).not.toContain('Event 25');
      expect(html).toContain('…and 5 more');
    });

    it('does not append a "more" line at exactly 25 cards, and shows a calm card for an empty summary', () => {
      expect(htmlBody(msg(Array.from({ length: 25 }, () => ev())))).not.toContain('more');
      const empty = htmlBody(msg([], { kind: 'summary' }));
      expect(empty).toContain('No current alerts.');
      expect(empty).toContain('Proxion notifications are active; no current alerts');
    });
  });

  it('resolveGuestName / enrichEvent resolve from a resources snapshot and never throw for a gone guest', () => {
    const resources = [
      { type: 'qemu', vmid: 100, node: 'c2dc2', name: 'web-prod-01' },
      { type: 'lxc', vmid: 200, node: 'c2dc2', name: 'db' },
      { type: 'storage', storage: 'local', node: 'c2dc2' },
    ];
    expect(resolveGuestName(resources, '100')).toBe('web-prod-01');
    expect(resolveGuestName(resources, '200')).toBe('db');
    expect(resolveGuestName(resources, '404')).toBeUndefined();
    expect(enrichEvent(ev({ vmid: '200' }), resources)).toMatchObject({ guestName: 'db', guestType: 'lxc' });
    const gone = ev({ vmid: '404' });
    expect(enrichEvent(gone, resources)).toBe(gone);
    const noVmid = ev({ node: 'c2dc2' });
    expect(enrichEvent(noVmid, resources)).toBe(noVmid);
  });
});

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

async function send(
  format: WebhookFormat,
  message: NotifyMessage,
  url = 'https://hooks.example.com/abc',
): Promise<Captured> {
  let captured: Captured | undefined;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    captured = {
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body),
    };
    return new Response('', { status: 200 });
  });
  await createWebhookChannel({ url, format, fetchImpl: fetchImpl as unknown as typeof fetch }).send(message);
  return captured!;
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

interface DiscordPayload {
  username: string;
  content: string;
  embeds: DiscordEmbed[];
}

function embedChars(embed: DiscordEmbed): number {
  return (
    embed.title.length +
    (embed.description?.length ?? 0) +
    (embed.footer?.text.length ?? 0) +
    (embed.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0)
  );
}

describe('discord payload', () => {
  it('{ username, content: headline, embeds[] } with colour, title, url, timestamp, Where field and footer', async () => {
    const captured = await send('discord', msg([GUEST_EVENT], { siteName: 'Proxion Prod' }));
    const payload = JSON.parse(captured.body) as DiscordPayload;
    expect(payload.username).toBe('Proxion Prod');
    expect(payload.content).toBe('1 opened');
    expect(payload.embeds).toEqual([
      {
        title: '🔴 NEW · Backup of web-prod-01 (VM 100) failed on c2dc2',
        description: 'vzdump exited with status 1',
        url: URL_VM,
        color: 0xdc2626,
        timestamp: '2026-10-06T15:58:00.000Z',
        fields: [{ name: 'Where', value: 'c2dc2 · web-prod-01 (VM 100)', inline: true }],
        footer: { text: 'Proxion Prod' },
      },
    ]);
  });

  it('omits description / url / fields / timestamp when there is nothing to put in them', async () => {
    const payload = JSON.parse((await send('discord', msg([ev({ at: Number.NaN })]))).body) as DiscordPayload;
    const embed = payload.embeds[0]!;
    expect(embed).not.toHaveProperty('description');
    expect(embed).not.toHaveProperty('url');
    expect(embed).not.toHaveProperty('fields');
    expect(embed).not.toHaveProperty('timestamp');
  });

  it('shows up to 10 events as 10 embeds, and never more than Discord\'s 10-embed limit', async () => {
    const ten = JSON.parse((await send('discord', msg(Array.from({ length: 10 }, () => ev())))).body) as DiscordPayload;
    expect(ten.embeds).toHaveLength(10);
    expect(ten.embeds.some((embed) => embed.title.includes('more'))).toBe(false);

    const twelve = JSON.parse((await send('discord', msg(Array.from({ length: 12 }, (_, i) => ev({ title: `E${i}` }))))).body) as DiscordPayload;
    expect(twelve.embeds).toHaveLength(10);
    expect(twelve.embeds[8]!.title).toContain('E8');
    expect(twelve.embeds[9]!.title).toBe('…and 3 more');
  });

  it('keeps the whole payload under Discord\'s 6000-character embed total by truncating descriptions', async () => {
    const events = Array.from({ length: 10 }, (_, i) => ev({ title: `Event ${i}`, detail: 'd'.repeat(4000), node: 'pve1' }));
    const payload = JSON.parse((await send('discord', msg(events))).body) as DiscordPayload;
    const total = payload.embeds.reduce((sum, embed) => sum + embedChars(embed), 0);
    expect(total).toBeLessThanOrEqual(6000);
    for (const embed of payload.embeds) {
      expect(embed.description!.length).toBeLessThanOrEqual(4096);
      expect(embed.description!.endsWith('…')).toBe(true);
    }
  });

  it('truncates a very long title to 256 characters and does not escape plain-text fields', async () => {
    const payload = JSON.parse(
      (await send('discord', msg([ev({ title: '<b>&' + 'x'.repeat(400) })]))).body,
    ) as DiscordPayload;
    expect(payload.embeds[0]!.title).toHaveLength(256);
    expect(payload.embeds[0]!.title).toContain('<b>&');
  });
});

interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  elements?: { type: string; text: string }[];
}

interface SlackPayload {
  text: string;
  blocks: SlackBlock[];
}

describe('slack payload', () => {
  it('{ text fallback, blocks: header, then section + context + divider per event }', async () => {
    const message = msg(
      [GUEST_EVENT, ev({ type: 'resolved', severity: 'healed', title: 'Storage ok', node: 'c2dc2' })],
      { siteName: 'Proxion Prod' },
    );
    const payload = JSON.parse((await send('slack', message)).body) as SlackPayload;
    expect(payload.text).toBe('Proxion Prod — 1 opened, 1 resolved');
    expect(payload.blocks).toHaveLength(7); // header + 2 x (section, context, divider)
    expect(payload.blocks[0]).toEqual({
      type: 'header',
      text: { type: 'plain_text', text: '🔴 Proxion Prod: 1 opened, 1 resolved', emoji: true },
    });
    expect(payload.blocks[1]).toEqual({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*NEW* <${URL_VM}|Backup of web-prod-01 (VM 100) failed on c2dc2>\nvzdump exited with status 1`,
      },
    });
    expect(payload.blocks[2]).toEqual({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'c2dc2 · web-prod-01 (VM 100) · 2026-10-06 15:58 UTC' }],
    });
    expect(payload.blocks[3]).toEqual({ type: 'divider' });
    // No url: the title is plain text.
    expect(payload.blocks[4]).toEqual({ type: 'section', text: { type: 'mrkdwn', text: '*RESOLVED* Storage ok' } });
  });

  it('escapes & < > in titles, details and meta (but not quotes)', async () => {
    const payload = JSON.parse(
      (await send('slack', msg([ev({ title: '<script>&"', detail: 'a < b & c', node: 'n<1>' })]))).body,
    ) as SlackPayload;
    expect(payload.blocks[1]!.text!.text).toBe('*NEW* &lt;script&gt;&amp;"\na &lt; b &amp; c');
    expect(payload.blocks[2]!.elements![0]!.text).toContain('n&lt;1&gt;');
    expect(JSON.stringify(payload.blocks)).not.toContain('<script>');
  });

  it('keeps `|` and `>` in a url from breaking the link syntax', async () => {
    const payload = JSON.parse(
      (await send('slack', msg([ev({ url: 'https://x.example.com/a|b>c' })]))).body,
    ) as SlackPayload;
    expect(payload.blocks[1]!.text!.text).toBe('*NEW* <https://x.example.com/a%7Cb%3Ec|Backup failed>');
  });

  it('caps events (16, so the message stays within Slack\'s 50 blocks) and adds an "…and N more" context', async () => {
    const events = Array.from({ length: 25 }, (_, i) => ev({ title: `E${i}`, node: 'pve1' }));
    const payload = JSON.parse((await send('slack', msg(events))).body) as SlackPayload;
    expect(payload.blocks).toHaveLength(1 + 16 * 3 + 1);
    expect(payload.blocks.length).toBeLessThanOrEqual(50);
    expect(payload.blocks.filter((b) => b.type === 'section')).toHaveLength(16);
    expect(payload.blocks.at(-1)).toEqual({ type: 'context', elements: [{ type: 'mrkdwn', text: '…and 9 more' }] });
  });

  it('limits the header to 150 characters and each section to 3000', async () => {
    const payload = JSON.parse(
      (await send('slack', msg([ev({ title: 't'.repeat(5000), detail: '&'.repeat(5000) })], { siteName: 's'.repeat(400) }))).body,
    ) as SlackPayload;
    expect(payload.blocks[0]!.text!.text.length).toBeLessThanOrEqual(150);
    expect(payload.blocks[1]!.text!.text.length).toBeLessThanOrEqual(3000);
  });

  it('never cuts an escaped entity in half when truncating a detail', async () => {
    const payload = JSON.parse(
      (await send('slack', msg([ev({ title: 'T', detail: '&'.repeat(5000) })]))).body,
    ) as SlackPayload;
    const text = payload.blocks[1]!.text!.text;
    expect(text.endsWith('…')).toBe(true);
    expect(text.slice(0, -1)).toMatch(/(&amp;)+$/);
  });
});

describe('ntfy request', () => {
  it('sends Markdown: yes, a markdown body, Click and Actions when there is a url', async () => {
    const captured = await send('ntfy', msg([GUEST_EVENT], { siteName: 'Proxion Prod' }));
    expect(captured.headers['Markdown']).toBe('yes');
    expect(captured.headers['Click']).toBe(URL_VM);
    expect(captured.headers['Actions']).toBe(`view, Open in Proxion, ${URL_VM}, clear=true`);
    expect(captured.headers['Title']).toBe('Proxion Prod: 1 opened');
    expect(captured.headers['Priority']).toBe('urgent');
    expect(captured.headers['Tags']).toBe('red_circle,computer');
    expect(captured.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(captured.body).toBe(markdownBody(msg([GUEST_EVENT])));
  });

  it('percent-encodes , and ; in the Actions url only (Click keeps the url as is)', async () => {
    const url = 'https://proxion.example.com/vm/n/qemu/1?a=1,2;b=3';
    const captured = await send('ntfy', msg([ev({ url })]));
    expect(captured.headers['Click']).toBe(url);
    expect(captured.headers['Actions']).toBe(
      'view, Open in Proxion, https://proxion.example.com/vm/n/qemu/1?a=1%2C2%3Bb=3, clear=true',
    );
  });

  it('omits Click and Actions without a url, and drops `computer` when no event has a vmid', async () => {
    const captured = await send('ntfy', msg([ev({ severity: 'warning', node: 'pve1' })]));
    expect(captured.headers['Markdown']).toBe('yes');
    expect(captured.headers).not.toHaveProperty('Click');
    expect(captured.headers).not.toHaveProperty('Actions');
    expect(captured.headers['Tags']).toBe('large_orange_circle');
    expect(captured.headers['Priority']).toBe('high');
  });

  it('uses the highest-severity event for the tag, and the first url for Click', async () => {
    const captured = await send(
      'ntfy',
      msg([
        ev({ type: 'resolved', severity: 'healed', url: 'https://a.example.com/' }),
        ev({ severity: 'warning', url: 'https://b.example.com/' }),
        ev({ severity: 'error', url: 'https://c.example.com/' }),
      ]),
    );
    expect(captured.headers['Tags']).toBe('red_circle');
    expect(captured.headers['Click']).toBe('https://a.example.com/');
  });

  it('keeps every header value ASCII even with a non-ASCII site name, title or url', async () => {
    const captured = await send(
      'ntfy',
      msg([ev({ url: 'https://proxion.example.com/vm/n/qemu/1?x=é', title: 'Zażółć 🔴' })], {
        siteName: 'Prøxion 🚀',
      }),
    );
    for (const value of Object.values(captured.headers)) {
      expect(value).toMatch(/^[\x20-\x7e]*$/);
    }
    expect(captured.headers['Title']).toBe('Prxion : 1 opened');
    // The glyphs live in the body, not the headers.
    expect(captured.body).toContain('Zażółć');
  });

  it('a test message keeps the "Test notification" headline in the Title', async () => {
    const captured = await send('ntfy', msg([ev()], { kind: 'test' }));
    expect(captured.headers['Title']).toMatch(/^Proxion: Test notification/);
  });
});

describe('gotify request', () => {
  it('sends a markdown message with client::display and, with a url, client::notification click', async () => {
    const captured = await send('gotify', msg([GUEST_EVENT], { siteName: 'Proxion Prod' }));
    expect(JSON.parse(captured.body)).toEqual({
      title: 'Proxion Prod: 1 opened',
      message: markdownBody(msg([GUEST_EVENT])),
      priority: 8,
      extras: {
        'client::display': { contentType: 'text/markdown' },
        'client::notification': { click: { url: URL_VM } },
      },
    });
  });

  it('omits client::notification without a url', async () => {
    const parsed = JSON.parse((await send('gotify', msg([ev({ severity: 'warning' })]))).body) as {
      priority: number;
      extras: Record<string, unknown>;
    };
    expect(parsed.priority).toBe(4);
    expect(parsed.extras).toEqual({ 'client::display': { contentType: 'text/markdown' } });
  });
});

describe('generic payload', () => {
  it('adds headline, highestSeverity, sentAt and per-event guestName/guestType/label/color', async () => {
    const message = msg([GUEST_EVENT, ev({ type: 'resolved', severity: 'healed', title: 'ok' })]);
    const parsed = JSON.parse((await send('generic', message)).body) as {
      site: string;
      summary: string;
      headline: string;
      highestSeverity: string;
      sentAt: string;
      events: Record<string, unknown>[];
    };
    expect(parsed.site).toBe('Proxion');
    expect(parsed.summary).toBe('1 opened, 1 resolved');
    expect(parsed.headline).toBe('1 opened, 1 resolved');
    expect(parsed.highestSeverity).toBe('error');
    expect(parsed.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(parsed.events[0]).toMatchObject({
      guestName: 'web-prod-01',
      guestType: 'qemu',
      label: 'NEW',
      color: '#DC2626',
    });
    expect(parsed.events[1]).toMatchObject({ label: 'RESOLVED', color: '#16A34A' });
  });
});

describe('email channel (nodemailer jsonTransport)', () => {
  it('sends subject, text and an html alternative with the severity colour, escaped title and button href', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const spy = vi.spyOn(transport, 'sendMail');
    const channel = createEmailChannel({
      smtpUrl: 'smtps://user:pass@smtp.example.com:465',
      from: 'proxion@example.com',
      to: 'ops@example.com',
      transport,
    });
    await channel.send(
      msg([ev({ title: '<script>&"', node: 'c2dc2', vmid: '100', guestName: 'web', guestType: 'qemu', url: URL_VM })]),
    );

    const info = (await spy.mock.results[0]!.value) as { message: string };
    const mail = JSON.parse(info.message) as { subject: string; text: string; html: string };
    expect(mail.subject).toBe('[Proxion] 1 opened — <script>&"');
    expect(mail.text).toContain('[NEW] <script>&"');
    expect(mail.html).toContain('#DC2626');
    expect(mail.html).toContain('&lt;script&gt;&amp;&quot;');
    expect(mail.html).toContain(`href="${URL_VM}"`);
    expect(mail.html).not.toContain('<script');
  });

  it('a test message gets the fixed test subject and the sample-alert headline in the html', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const spy = vi.spyOn(transport, 'sendMail');
    const channel = createEmailChannel({
      smtpUrl: 'smtp://smtp.example.com:587',
      from: 'a@example.com',
      to: 'b@example.com',
      transport,
    });
    await channel.send(msg([GUEST_EVENT], { kind: 'test' }));
    const call = spy.mock.calls[0]![0] as { subject: string; html: string };
    expect(call.subject).toBe('[Proxion] Test notification');
    expect(call.html).toContain('Test notification - these are sample alerts');
  });
});
