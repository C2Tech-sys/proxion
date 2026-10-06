import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import nodemailer from 'nodemailer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Alert } from '@proxion/core';
import { createWebhookChannel, type WebhookFormat } from '../src/notify/channels/webhook.js';
import { createEmailChannel } from '../src/notify/channels/email.js';
import { Notifier } from '../src/notify/notifier.js';
import type { NotifyMessage } from '../src/notify/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

interface FakeServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startFakeWebhook(handler: Handler): Promise<FakeServer> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let activeServer: FakeServer | undefined;

afterEach(async () => {
  await activeServer?.close();
  activeServer = undefined;
});

const TRANSITIONS_MESSAGE: NotifyMessage = {
  kind: 'transitions',
  siteName: 'Proxion Test',
  events: [
    {
      type: 'opened',
      severity: 'error',
      kind: 'backup',
      title: 'Backup failed for vm 101',
      detail: 'pve1',
      node: 'pve1',
      vmid: '101',
      at: 1_700_000_000,
      url: 'https://proxion.example.com/vm/pve1/qemu/101?tab=summary',
    },
  ],
};

describe('webhook channel formats', () => {
  it('generic: JSON { site, summary, events } with the exact event fields', async () => {
    let received: { headers: IncomingMessage['headers']; body: string } | undefined;
    activeServer = await startFakeWebhook((req, res, body) => {
      received = { headers: req.headers, body };
      res.writeHead(200);
      res.end();
    });

    const channel = createWebhookChannel({ url: activeServer.baseUrl, format: 'generic' });
    await channel.send(TRANSITIONS_MESSAGE);

    expect(received?.headers['content-type']).toBe('application/json');
    const parsed = JSON.parse(received!.body) as { site: string; summary: string; events: unknown[] };
    expect(parsed.site).toBe('Proxion Test');
    expect(parsed.events).toEqual([
      {
        type: 'opened',
        severity: 'error',
        kind: 'backup',
        title: 'Backup failed for vm 101',
        detail: 'pve1',
        node: 'pve1',
        vmid: '101',
        // T58: every event now also carries its display label and accent colour.
        label: 'NEW',
        color: '#DC2626',
        at: 1_700_000_000,
        url: 'https://proxion.example.com/vm/pve1/qemu/101?tab=summary',
      },
    ]);
  });

  it('discord: JSON { username, content, embeds } -- long text is truncated to fit Discord limits', async () => {
    let receivedBody = '';
    activeServer = await startFakeWebhook((_req, res, body) => {
      receivedBody = body;
      res.writeHead(200);
      res.end();
    });
    const channel = createWebhookChannel({ url: activeServer.baseUrl, format: 'discord' });

    // A message whose single-line body would exceed 1900 chars.
    const longMessage: NotifyMessage = {
      kind: 'transitions',
      siteName: 'Proxion',
      events: [
        {
          type: 'opened',
          severity: 'error',
          kind: 'task',
          title: 'x'.repeat(2500),
          at: 1,
        },
      ],
    };
    await channel.send(longMessage);
    // T58: the long text now lives in an embed title (<= 256), not in `content`.
    const parsed = JSON.parse(receivedBody) as { content: string; embeds: { title: string }[] };
    expect(parsed.content.length).toBeLessThanOrEqual(1900);
    expect(parsed.embeds[0]!.title.length).toBeLessThanOrEqual(256);
    expect(parsed.embeds[0]!.title.endsWith('…')).toBe(true);

    // A short message round-trips its title and site name (username + footer) untruncated.
    await channel.send(TRANSITIONS_MESSAGE);
    const short = JSON.parse(receivedBody) as {
      username: string;
      embeds: { title: string; footer: { text: string } }[];
    };
    expect(short.username).toBe('Proxion Test');
    expect(short.embeds[0]!.footer.text).toBe('Proxion Test');
    expect(short.embeds[0]!.title).toContain('Backup failed for vm 101');
  });

  it('slack: JSON { text, blocks }', async () => {
    let receivedBody = '';
    activeServer = await startFakeWebhook((_req, res, body) => {
      receivedBody = body;
      res.writeHead(200);
      res.end();
    });
    const channel = createWebhookChannel({ url: activeServer.baseUrl, format: 'slack' });
    await channel.send(TRANSITIONS_MESSAGE);
    // T58: `text` is now only the notification fallback; the event lives in the blocks.
    const parsed = JSON.parse(receivedBody) as { text: string; blocks: unknown[] };
    expect(parsed.text).toContain('Proxion Test');
    expect(JSON.stringify(parsed.blocks)).toContain('Backup failed for vm 101');
  });

  it('ntfy: plain-text body with Title/Priority/Tags headers', async () => {
    let received: { headers: IncomingMessage['headers']; body: string } | undefined;
    activeServer = await startFakeWebhook((req, res, body) => {
      received = { headers: req.headers, body };
      res.writeHead(200);
      res.end();
    });
    const channel = createWebhookChannel({ url: activeServer.baseUrl, format: 'ntfy' });
    await channel.send(TRANSITIONS_MESSAGE);

    expect(received?.headers['content-type']).toContain('text/plain');
    expect(received?.headers['title']).toContain('Proxion Test');
    expect(received?.headers['priority']).toBe('urgent'); // highest severity in the message is 'error'
    expect(received?.headers['tags']).toBeTruthy();
    expect(received?.body).toContain('Backup failed for vm 101');
  });

  it('gotify: JSON { title, message, priority }', async () => {
    let receivedBody = '';
    activeServer = await startFakeWebhook((_req, res, body) => {
      receivedBody = body;
      res.writeHead(200);
      res.end();
    });
    const channel = createWebhookChannel({ url: activeServer.baseUrl, format: 'gotify' });
    await channel.send(TRANSITIONS_MESSAGE);
    const parsed = JSON.parse(receivedBody) as { title: string; message: string; priority: number };
    expect(parsed.title).toContain('Proxion Test');
    expect(parsed.message).toContain('Backup failed for vm 101');
    expect(parsed.priority).toBeGreaterThan(0);
  });

  it('sends the configured token as Authorization: Bearer <token>', async () => {
    let authHeader: string | undefined;
    activeServer = await startFakeWebhook((req, res) => {
      authHeader = req.headers.authorization;
      res.writeHead(200);
      res.end();
    });
    const channel = createWebhookChannel({ url: activeServer.baseUrl, format: 'generic', token: 'super-secret-token' });
    await channel.send(TRANSITIONS_MESSAGE);
    expect(authHeader).toBe('Bearer super-secret-token');
  });

  it('sends no Authorization header when no token is configured', async () => {
    let authHeader: string | undefined = 'unset';
    activeServer = await startFakeWebhook((req, res) => {
      authHeader = req.headers.authorization;
      res.writeHead(200);
      res.end();
    });
    const channel = createWebhookChannel({ url: activeServer.baseUrl, format: 'generic' });
    await channel.send(TRANSITIONS_MESSAGE);
    expect(authHeader).toBeUndefined();
  });

  it('throws on a non-2xx response (so Notifier can retry/log it)', async () => {
    activeServer = await startFakeWebhook((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    const channel = createWebhookChannel({ url: activeServer.baseUrl, format: 'generic' });
    await expect(channel.send(TRANSITIONS_MESSAGE)).rejects.toThrow(/500/);
  });

  it('times out and throws after timeoutMs when the server never responds', async () => {
    activeServer = await startFakeWebhook(() => {
      // Never calls res.end() -- the request hangs until the channel's own timeout fires.
    });
    const channel = createWebhookChannel({ url: activeServer.baseUrl, format: 'generic', timeoutMs: 50 });
    await expect(channel.send(TRANSITIONS_MESSAGE)).rejects.toThrow(/timed out/);
  });

  it('every format works for every WebhookFormat value (exhaustiveness)', async () => {
    activeServer = await startFakeWebhook((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    const formats: WebhookFormat[] = ['generic', 'discord', 'slack', 'ntfy', 'gotify'];
    for (const format of formats) {
      const channel = createWebhookChannel({ url: activeServer.baseUrl, format });
      await expect(channel.send(TRANSITIONS_MESSAGE)).resolves.toBeUndefined();
    }
  });
});

describe('email channel', () => {
  it('sends a plain-text message with the expected subject/from/to via an injected transport', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const channel = createEmailChannel({
      smtpUrl: 'smtps://user:pass@smtp.example.com:465',
      from: 'proxion@example.com',
      to: 'ops@example.com,oncall@example.com',
      transport,
    });

    // jsonTransport's sendMail resolves with `info.message` -- the fully-composed message as a
    // JSON string -- letting us assert on subject/text without any real SMTP connection.
    const sendMailSpy = vi.spyOn(transport, 'sendMail');
    await channel.send(TRANSITIONS_MESSAGE);

    expect(sendMailSpy).toHaveBeenCalledTimes(1);
    const call = sendMailSpy.mock.calls[0]![0] as { from: string; to: string; subject: string; text: string };
    expect(call.from).toBe('proxion@example.com');
    expect(call.to).toBe('ops@example.com,oncall@example.com');
    // T58: the subject is now `[site] headline — first title`.
    expect(call.subject).toBe('[Proxion Test] 1 opened — Backup failed for vm 101');
    expect(call.text).toContain('Backup failed for vm 101');
    expect(call.text).toContain('https://proxion.example.com/vm/pve1/qemu/101?tab=summary');
  });

  it('exposes only the SMTP host, never the embedded credentials', () => {
    const channel = createEmailChannel({
      smtpUrl: 'smtps://someuser:supersecretpassword@smtp.example.com:465',
      from: 'proxion@example.com',
      to: 'ops@example.com',
      transport: nodemailer.createTransport({ jsonTransport: true }),
    });
    expect(channel.host).toBe('smtp.example.com:465');
    expect(channel.host).not.toContain('someuser');
    expect(channel.host).not.toContain('supersecretpassword');
  });

  it('propagates a transport failure so Notifier can retry/log it', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    vi.spyOn(transport, 'sendMail').mockRejectedValue(new Error('smtp rejected'));
    const channel = createEmailChannel({
      smtpUrl: 'smtp://user:pass@smtp.example.com:587',
      from: 'a@example.com',
      to: 'b@example.com',
      transport,
    });
    await expect(channel.send(TRANSITIONS_MESSAGE)).rejects.toThrow(/smtp rejected/);
  });
});

describe('token/credentials never reach the logger', () => {
  let dataDir: string;

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a failing webhook with a token never logs the token, URL query, or SMTP credentials', async () => {
    activeServer = await startFakeWebhook((_req, res) => {
      res.writeHead(403);
      res.end('forbidden');
    });
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'proxion-notify-log-test-'));
    const secretToken = 'sooper-secret-webhook-token';
    const channel = createWebhookChannel({ url: activeServer.baseUrl, format: 'generic', token: secretToken });

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const notifier = await Notifier.create({
      dataDir,
      minSeverity: 'warning',
      includeResolved: true,
      debounceMs: 10,
      siteName: 'Proxion',
      channels: [channel],
      log,
      maxAttempts: 1,
    });

    // Force straight past the first-run summary (empty) so the assertion below only has to
    // reason about the one send we care about.
    notifier.onAlerts([]);
    await notifier.flushForTest();
    log.warn.mockClear();
    log.error.mockClear();

    const failingAlert: Alert = { id: 'x', kind: 'task', severity: 'error', title: 'Something broke', at: 1 };
    notifier.onAlerts([failingAlert]);
    await notifier.flushForTest();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await notifier.flushForTest();

    const allCalls = [...log.warn.mock.calls, ...log.error.mock.calls];
    expect(allCalls.length).toBeGreaterThan(0);
    for (const call of allCalls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(secretToken);
      expect(serialized).not.toContain(activeServer.baseUrl);
    }
  });
});
