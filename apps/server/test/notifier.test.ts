import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Alert } from '@proxion/core';
import { summaryHeadline } from '../src/notify/format.js';
import { WebhookSendError } from '../src/notify/channels/webhook.js';
import { Notifier, type NotifierOptions } from '../src/notify/notifier.js';
import type { NotifyChannel, NotifyMessage } from '../src/notify/types.js';

/** A `NotifyLogger` (structurally -- `Notifier.create` accepts it as one) whose three methods are
 *  each a `vi.fn()`, so tests can assert on `.mock.calls`/`mockClear()` directly. */
function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A channel whose `send` is a `vi.fn()` -- `impl` optionally overrides its resolution per call
 *  (1-indexed), defaulting to always resolving. */
function fakeChannel(name: 'webhook' | 'email', impl?: (call: number) => Promise<void>): NotifyChannel & {
  send: ReturnType<typeof vi.fn>;
} {
  let call = 0;
  const send = vi.fn(async () => {
    call += 1;
    if (impl) await impl(call);
  });
  return { name, host: `${name}.example.com`, send };
}

function alert(overrides: Partial<Alert> & Pick<Alert, 'id' | 'kind' | 'severity' | 'title'>): Alert {
  return { at: 1_000, ...overrides };
}

const BASE_OPTIONS = {
  minSeverity: 'warning' as const,
  includeResolved: true,
  debounceMs: 10_000,
  siteName: 'TestSite',
};

/**
 * Advances vitest's fake clock by `ms` for the debounce timer `Notifier.scheduleFlush` registers,
 * then awaits the resulting flush. Callers must `await notifier.flushForTest()` (which resolves
 * once `onAlerts`'s internal promise chain -- including the real `fs` calls in `persistState` --
 * has actually run `scheduleFlush` and registered its `setTimeout`) BEFORE calling this, or the
 * timer may not exist yet when the fake clock advances past it.
 */
async function advanceAndFlush(notifier: Notifier, ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await notifier.flushForTest();
}

describe('Notifier', () => {
  let dataDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'proxion-notify-test-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('first run with no alerts sends a single "no current alerts" summary and seeds empty state', async () => {
    const channel = fakeChannel('webhook');
    const notifier = await Notifier.create({ ...BASE_OPTIONS, dataDir, channels: [channel], log: fakeLogger() });

    notifier.onAlerts([]);
    await notifier.flushForTest();

    expect(channel.send).toHaveBeenCalledTimes(1);
    const message = channel.send.mock.calls[0]![0] as NotifyMessage;
    expect(message.kind).toBe('summary');
    expect(message.events).toHaveLength(0);
  });

  it('first run with existing alerts summarises them once and does not re-announce them as opened', async () => {
    const channel = fakeChannel('webhook');
    const notifier = await Notifier.create({ ...BASE_OPTIONS, dataDir, channels: [channel], log: fakeLogger() });

    const a = alert({ id: 'task:1', kind: 'task', severity: 'error', title: 'Backup failed' });
    notifier.onAlerts([a]);
    await notifier.flushForTest();

    expect(channel.send).toHaveBeenCalledTimes(1);
    const message = channel.send.mock.calls[0]![0] as NotifyMessage;
    expect(message.kind).toBe('summary');
    expect(message.events).toHaveLength(1);
    expect(message.events[0]?.type).toBe('summary-item');

    // Same alert again on the next snapshot: already known from the summary seed, so no further
    // 'opened' event should ever fire for it.
    channel.send.mockClear();
    notifier.onAlerts([a]);
    await notifier.flushForTest();
    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('a new alert at/above minSeverity opens, batched after the debounce window', async () => {
    const channel = fakeChannel('webhook');
    const notifier = await Notifier.create({ ...BASE_OPTIONS, dataDir, channels: [channel], log: fakeLogger() });
    notifier.onAlerts([]); // first-run summary (empty)
    await notifier.flushForTest();
    channel.send.mockClear();

    const a = alert({ id: 'storage:full', kind: 'storage', severity: 'error', title: 'Storage nearly full' });
    notifier.onAlerts([a]);
    await notifier.flushForTest(); // lets processSnapshot run + register the debounce timer
    expect(channel.send).not.toHaveBeenCalled(); // still inside the debounce window

    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);

    expect(channel.send).toHaveBeenCalledTimes(1);
    const message = channel.send.mock.calls[0]![0] as NotifyMessage;
    expect(message.kind).toBe('transitions');
    expect(message.events).toEqual([expect.objectContaining({ type: 'opened', title: 'Storage nearly full' })]);
  });

  it('a new alert below minSeverity is tracked silently (no opened notice)', async () => {
    const channel = fakeChannel('webhook');
    const notifier = await Notifier.create({
      ...BASE_OPTIONS,
      minSeverity: 'error',
      dataDir,
      channels: [channel],
      log: fakeLogger(),
    });
    notifier.onAlerts([]);
    await notifier.flushForTest();
    channel.send.mockClear();

    const a = alert({ id: 'task:2', kind: 'task', severity: 'warning', title: 'Minor task issue' });
    notifier.onAlerts([a]);
    await notifier.flushForTest();
    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('warning -> error on an already-opened alert is an escalated event, not a second opened', async () => {
    const channel = fakeChannel('webhook');
    const notifier = await Notifier.create({ ...BASE_OPTIONS, dataDir, channels: [channel], log: fakeLogger() });
    notifier.onAlerts([]);
    await notifier.flushForTest();
    channel.send.mockClear();

    const warn = alert({ id: 'task:3', kind: 'task', severity: 'warning', title: 'Task warning' });
    notifier.onAlerts([warn]);
    await notifier.flushForTest();
    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);
    expect((channel.send.mock.calls[0]![0] as NotifyMessage).events[0]?.type).toBe('opened');
    channel.send.mockClear();

    const escalated = alert({ id: 'task:3', kind: 'task', severity: 'error', title: 'Task warning' });
    notifier.onAlerts([escalated]);
    await notifier.flushForTest();
    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect((channel.send.mock.calls[0]![0] as NotifyMessage).events[0]?.type).toBe('escalated');
  });

  it('a warning below minSeverity that crosses to error is its first opened, not an escalation', async () => {
    const channel = fakeChannel('webhook');
    const notifier = await Notifier.create({
      ...BASE_OPTIONS,
      minSeverity: 'error',
      dataDir,
      channels: [channel],
      log: fakeLogger(),
    });
    notifier.onAlerts([]);
    await notifier.flushForTest();
    channel.send.mockClear();

    notifier.onAlerts([alert({ id: 'task:4', kind: 'task', severity: 'warning', title: 'Quiet warning' })]);
    await notifier.flushForTest();
    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);
    expect(channel.send).not.toHaveBeenCalled();

    notifier.onAlerts([alert({ id: 'task:4', kind: 'task', severity: 'error', title: 'Quiet warning' })]);
    await notifier.flushForTest();
    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect((channel.send.mock.calls[0]![0] as NotifyMessage).events[0]?.type).toBe('opened');
  });

  it('a healed, previously-opened alert sends a resolved event', async () => {
    const channel = fakeChannel('webhook');
    const notifier = await Notifier.create({ ...BASE_OPTIONS, dataDir, channels: [channel], log: fakeLogger() });
    const open = alert({ id: 'backup:1', kind: 'backup', severity: 'error', title: 'Backup failed for vm 101' });
    notifier.onAlerts([open]);
    await notifier.flushForTest();
    channel.send.mockClear();

    const healed = alert({ id: 'backup:1', kind: 'backup', severity: 'healed', title: 'Backup healed for vm 101' });
    notifier.onAlerts([healed]);
    await notifier.flushForTest();
    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);
    expect((channel.send.mock.calls[0]![0] as NotifyMessage).events[0]).toEqual(
      expect.objectContaining({ type: 'resolved' }),
    );
  });

  it('respects includeResolved=false: no resolved/cleared notices', async () => {
    const channel = fakeChannel('webhook');
    const notifier = await Notifier.create({
      ...BASE_OPTIONS,
      includeResolved: false,
      dataDir,
      channels: [channel],
      log: fakeLogger(),
    });
    const open = alert({ id: 'backup:2', kind: 'backup', severity: 'error', title: 'Backup failed' });
    notifier.onAlerts([open]);
    await notifier.flushForTest();
    channel.send.mockClear();

    notifier.onAlerts([]); // disappeared
    await notifier.flushForTest();
    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('a previously-opened alert that disappears sends a cleared event worded "No longer reported"', async () => {
    const channel = fakeChannel('webhook');
    const notifier = await Notifier.create({ ...BASE_OPTIONS, dataDir, channels: [channel], log: fakeLogger() });
    const open = alert({ id: 'task:5', kind: 'task', severity: 'error', title: 'Task failed' });
    notifier.onAlerts([open]);
    await notifier.flushForTest();
    channel.send.mockClear();

    notifier.onAlerts([]);
    await notifier.flushForTest();
    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);
    const events = (channel.send.mock.calls[0]![0] as NotifyMessage).events;
    expect(events).toEqual([
      expect.objectContaining({ type: 'cleared', title: 'Task failed', detail: 'No longer reported' }),
    ]);
  });

  it('batches multiple transitions within the debounce window into one message per channel', async () => {
    const channel = fakeChannel('webhook');
    const notifier = await Notifier.create({ ...BASE_OPTIONS, dataDir, channels: [channel], log: fakeLogger() });
    notifier.onAlerts([]);
    await notifier.flushForTest();
    channel.send.mockClear();

    notifier.onAlerts([alert({ id: 'a', kind: 'task', severity: 'error', title: 'A' })]);
    await notifier.flushForTest(); // registers the debounce timer
    await vi.advanceTimersByTimeAsync(3_000); // well within the 10s window -- no flush yet

    notifier.onAlerts([
      alert({ id: 'a', kind: 'task', severity: 'error', title: 'A' }),
      alert({ id: 'b', kind: 'task', severity: 'error', title: 'B' }),
    ]);
    await notifier.flushForTest();
    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);

    expect(channel.send).toHaveBeenCalledTimes(1);
    const events = (channel.send.mock.calls[0]![0] as NotifyMessage).events;
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.title).sort()).toEqual(['A', 'B']);
  });

  it('persists known state to disk and a fresh Notifier over the same dataDir does not re-notify', async () => {
    const channelA = fakeChannel('webhook');
    const notifierA = await Notifier.create({ ...BASE_OPTIONS, dataDir, channels: [channelA], log: fakeLogger() });
    const open = alert({ id: 'task:6', kind: 'task', severity: 'error', title: 'Persisted task' });
    notifierA.onAlerts([open]); // first run: summary
    await notifierA.flushForTest();

    const stateRaw = readFileSync(path.join(dataDir, 'notify-state.json'), 'utf8');
    const state = JSON.parse(stateRaw) as { alerts: Record<string, unknown> };
    expect(state.alerts['task:6']).toBeTruthy();

    const channelB = fakeChannel('webhook');
    const notifierB = await Notifier.create({ ...BASE_OPTIONS, dataDir, channels: [channelB], log: fakeLogger() });
    notifierB.onAlerts([open]); // same alert again -- restart must not re-announce it
    await notifierB.flushForTest();
    await advanceAndFlush(notifierB, BASE_OPTIONS.debounceMs);
    expect(channelB.send).not.toHaveBeenCalled();
  });

  it('retries a failing channel up to maxAttempts, logs a warning per failed attempt, and never throws', async () => {
    let attempts = 0;
    const channel = fakeChannel('webhook', async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('boom');
    });
    const log = fakeLogger();
    const notifier = await Notifier.create({ ...BASE_OPTIONS, maxAttempts: 3, dataDir, channels: [channel], log });
    notifier.onAlerts([]);
    await notifier.flushForTest();
    channel.send.mockClear();
    log.warn.mockClear();
    log.error.mockClear();
    attempts = 0;

    notifier.onAlerts([alert({ id: 'x', kind: 'task', severity: 'error', title: 'Flaky' })]);
    await notifier.flushForTest();
    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);

    expect(channel.send).toHaveBeenCalledTimes(3); // 2 failures + 1 success
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxAttempts and logs an error, without throwing out of the listener', async () => {
    const channel = fakeChannel('webhook', async () => {
      throw new Error('always fails');
    });
    const log = fakeLogger();
    const notifier = await Notifier.create({ ...BASE_OPTIONS, maxAttempts: 3, dataDir, channels: [channel], log });
    notifier.onAlerts([]);
    await notifier.flushForTest();
    channel.send.mockClear();

    expect(() => {
      notifier.onAlerts([alert({ id: 'y', kind: 'task', severity: 'error', title: 'Always broken' })]);
    }).not.toThrow();
    await notifier.flushForTest();
    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);

    expect(channel.send).toHaveBeenCalledTimes(3);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'webhook', host: 'webhook.example.com' }),
      expect.stringContaining('failed after all retries'),
    );
  });

  it('never logs the raw error message (only the channel name/host) on a channel failure', async () => {
    const channel = fakeChannel('webhook', async () => {
      throw new Error('secret-token-should-not-be-logged');
    });
    const log = fakeLogger();
    const notifier = await Notifier.create({ ...BASE_OPTIONS, maxAttempts: 1, dataDir, channels: [channel], log });
    notifier.onAlerts([]);
    await notifier.flushForTest();

    notifier.onAlerts([alert({ id: 'z', kind: 'task', severity: 'error', title: 'Secret leak check' })]);
    await notifier.flushForTest();
    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);

    const allLogCalls = [
      ...(log.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(log.error as ReturnType<typeof vi.fn>).mock.calls,
    ];
    for (const call of allLogCalls) {
      expect(JSON.stringify(call)).not.toContain('secret-token-should-not-be-logged');
    }
  });

  it('enriches guest events with guestName/guestType from the resources snapshot, and never throws for a vanished guest', async () => {
    const channel = fakeChannel('webhook');
    const resources = [{ type: 'qemu', vmid: 100, node: 'c2dc2', name: 'web-prod-01' }];
    const notifier = await Notifier.create({
      ...BASE_OPTIONS,
      dataDir,
      channels: [channel],
      log: fakeLogger(),
      publicUrl: 'https://proxion.example.com',
      getResources: () => resources,
    });
    notifier.onAlerts([]);
    await notifier.flushForTest();
    channel.send.mockClear();

    notifier.onAlerts([
      alert({ id: 'backup:c2dc2:100:u1', kind: 'backup', severity: 'error', title: 'Backup failed', node: 'c2dc2', vmid: '100' }),
      alert({ id: 'backup:c2dc2:999:u2', kind: 'backup', severity: 'error', title: 'Gone guest', node: 'c2dc2', vmid: '999' }),
      alert({ id: 'storage:c2dc2:local', kind: 'storage', severity: 'error', title: 'Storage full', node: 'c2dc2' }),
    ]);
    await notifier.flushForTest();
    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);

    const events = (channel.send.mock.calls[0]![0] as NotifyMessage).events;
    expect(events[0]).toMatchObject({ vmid: '100', guestName: 'web-prod-01', guestType: 'qemu' });
    expect(events[0]?.url).toBe('https://proxion.example.com/vm/c2dc2/qemu/100?tab=summary');
    expect(events[1]?.guestName).toBeUndefined();
    expect(events[1]?.guestType).toBeUndefined();
    expect(events[2]?.guestName).toBeUndefined();
  });

  it('survives a throwing getResources (events are sent without guest names)', async () => {
    const channel = fakeChannel('webhook');
    const notifier = await Notifier.create({
      ...BASE_OPTIONS,
      dataDir,
      channels: [channel],
      log: fakeLogger(),
      getResources: () => {
        throw new Error('no snapshot');
      },
    });
    notifier.onAlerts([]);
    await notifier.flushForTest();
    channel.send.mockClear();

    notifier.onAlerts([alert({ id: 'q', kind: 'task', severity: 'error', title: 'Q', vmid: '100', node: 'n' })]);
    await notifier.flushForTest();
    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);
    const events = (channel.send.mock.calls[0]![0] as NotifyMessage).events;
    expect(events).toHaveLength(1);
    expect(events[0]?.guestName).toBeUndefined();
  });

  it('sendTest sends two realistic sample events (failure + all-clear) with a "Test notification" headline', async () => {
    const channel = fakeChannel('webhook');
    const notifier = await Notifier.create({
      ...BASE_OPTIONS,
      dataDir,
      channels: [channel],
      log: fakeLogger(),
      publicUrl: 'https://proxion.example.com/',
      clock: () => 1_791_302_280_000, // 2026-10-06 15:58:00 UTC
    });

    await expect(notifier.sendTest()).resolves.toEqual({ webhook: 'ok' });

    const message = channel.send.mock.calls[0]![0] as NotifyMessage;
    expect(message.kind).toBe('test');
    expect(summaryHeadline(message).startsWith('Test notification')).toBe(true);
    expect(message.events).toEqual([
      {
        type: 'opened',
        severity: 'error',
        kind: 'backup',
        title: 'Backup of web-prod-01 (VM 100) failed on c2dc2',
        detail: 'vzdump exited with status 1 — see the task log',
        node: 'c2dc2',
        vmid: '100',
        guestName: 'web-prod-01',
        guestType: 'qemu',
        at: 1_791_302_280,
        url: 'https://proxion.example.com/',
      },
      {
        type: 'resolved',
        severity: 'healed',
        kind: 'storage',
        title: 'Storage "local-lvm" on c2dc2 is back under 90%',
        node: 'c2dc2',
        at: 1_791_302_280,
        url: 'https://proxion.example.com/',
      },
    ]);
  });

  it('sendTest leaves the url off when no PROXION_PUBLIC_URL is configured', async () => {
    const channel = fakeChannel('webhook');
    const notifier = await Notifier.create({ ...BASE_OPTIONS, dataDir, channels: [channel], log: fakeLogger() });
    await notifier.sendTest();
    const message = channel.send.mock.calls[0]![0] as NotifyMessage;
    expect(message.events.every((event) => event.url === undefined)).toBe(true);
  });
});

// --- T64: master switch, snooze and per-kind muting ---------------------------------------------
describe('Notifier muting (T64)', () => {
  let dataDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'proxion-notify-mute-test-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const backupFailed = alert({ id: 'backup:100', kind: 'backup', severity: 'error', title: 'Backup of VM 100 failed' });
  const diskFull = alert({ id: 'storage:local', kind: 'storage', severity: 'error', title: 'Storage local is full' });

  /** Seeds the first-run baseline with an empty snapshot, then clears the summary send. */
  async function seeded(extra: Partial<NotifierOptions> = {}) {
    const channel = fakeChannel('webhook');
    const notifier = await Notifier.create({
      ...BASE_OPTIONS,
      dataDir,
      channels: [channel],
      log: fakeLogger(),
      ...extra,
    });
    notifier.onAlerts([]);
    await notifier.flushForTest();
    channel.send.mockClear();
    return { channel, notifier };
  }

  it('drops events of a muted kind and still sends the others', async () => {
    const { channel, notifier } = await seeded({ mutedKinds: ['backup'] });
    notifier.onAlerts([backupFailed, diskFull]);
    await notifier.flushForTest();
    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);

    expect(channel.send).toHaveBeenCalledTimes(1);
    const message = channel.send.mock.calls[0]![0] as NotifyMessage;
    expect(message.events.map((event) => event.kind)).toEqual(['storage']);
  });

  it('a muted kind is still tracked: un-muting does not replay it', async () => {
    const { channel, notifier } = await seeded({ mutedKinds: ['backup'] });
    notifier.onAlerts([backupFailed]);
    await notifier.flushForTest();
    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);
    expect(channel.send).not.toHaveBeenCalled();

    // A new notifier over the same state, with nothing muted: the alert is already known/open.
    const fresh = fakeChannel('webhook');
    const unmuted = await Notifier.create({ ...BASE_OPTIONS, dataDir, channels: [fresh], log: fakeLogger() });
    unmuted.onAlerts([backupFailed]);
    await unmuted.flushForTest();
    await advanceAndFlush(unmuted, BASE_OPTIONS.debounceMs);
    expect(fresh.send).not.toHaveBeenCalled();
  });

  it('enabled: false sends nothing, not even the first-run summary, but seeds the baseline', async () => {
    const channel = fakeChannel('webhook');
    const notifier = await Notifier.create({
      ...BASE_OPTIONS,
      dataDir,
      channels: [channel],
      log: fakeLogger(),
      enabled: false,
    });
    notifier.onAlerts([backupFailed]);
    await notifier.flushForTest();
    notifier.onAlerts([backupFailed, diskFull]);
    await notifier.flushForTest();
    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);
    expect(channel.send).not.toHaveBeenCalled();

    const state = JSON.parse(readFileSync(path.join(dataDir, 'notify-state.json'), 'utf8')) as {
      alerts: Record<string, unknown>;
    };
    expect(Object.keys(state.alerts).sort()).toEqual(['backup:100', 'storage:local']);
  });

  it('a future muteUntil sends nothing; once it has expired new alerts are sent again', async () => {
    const muteUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { channel, notifier } = await seeded({ muteUntil });

    notifier.onAlerts([backupFailed]);
    await notifier.flushForTest();
    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);
    expect(channel.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000); // snooze over
    notifier.onAlerts([backupFailed, diskFull]);
    await notifier.flushForTest();
    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);

    // Only the alert that opened after the snooze -- the one from during it is not replayed.
    expect(channel.send).toHaveBeenCalledTimes(1);
    const message = channel.send.mock.calls[0]![0] as NotifyMessage;
    expect(message.events.map((event) => event.title)).toEqual(['Storage local is full']);
  });

  it('an already-expired muteUntil does not mute', async () => {
    const muteUntil = new Date(Date.now() - 1000).toISOString();
    const { channel, notifier } = await seeded({ muteUntil });
    notifier.onAlerts([backupFailed]);
    await notifier.flushForTest();
    await advanceAndFlush(notifier, BASE_OPTIONS.debounceMs);
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('sendTest ignores enabled, muteUntil and mutedKinds', async () => {
    const channel = fakeChannel('webhook');
    const notifier = await Notifier.create({
      ...BASE_OPTIONS,
      dataDir,
      channels: [channel],
      log: fakeLogger(),
      enabled: false,
      muteUntil: new Date(Date.now() + 3_600_000).toISOString(),
      mutedKinds: ['backup', 'task', 'storage'],
    });
    await expect(notifier.sendTest()).resolves.toEqual({ webhook: 'ok' });
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('stop() drops the unsent batch and ignores later snapshots', async () => {
    const { channel, notifier } = await seeded();
    notifier.onAlerts([backupFailed]);
    await notifier.flushForTest(); // queued, debounce timer pending
    await notifier.stop();
    await vi.advanceTimersByTimeAsync(BASE_OPTIONS.debounceMs * 2);
    notifier.onAlerts([backupFailed, diskFull]);
    await notifier.flushForTest();
    await vi.advanceTimersByTimeAsync(BASE_OPTIONS.debounceMs * 2);
    expect(channel.send).not.toHaveBeenCalled();
  });
});

// --- T64 hardening: what "Send test" may tell the operator about a failure ---------------------
describe('Notifier.sendTest failure reporting', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'proxion-notify-sanitise-test-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function reportFor(name: 'webhook' | 'email', error: unknown): Promise<string> {
    const channel = fakeChannel(name, () => Promise.reject(error));
    const notifier = await Notifier.create({ ...BASE_OPTIONS, dataDir, channels: [channel], log: fakeLogger() });
    const results = await notifier.sendTest();
    return results[name]!;
  }

  it('reduces a webhook HTTP failure to its status code only', async () => {
    expect(await reportFor('webhook', new WebhookSendError('http', 502))).toBe('request failed (HTTP 502)');
    expect(await reportFor('webhook', new WebhookSendError('http', 302))).toBe('request failed (HTTP 302)');
  });

  it('reduces a webhook timeout and a network failure to one word each', async () => {
    expect(await reportFor('webhook', new WebhookSendError('timeout'))).toBe('request failed (timeout)');
    expect(await reportFor('webhook', new WebhookSendError('network'))).toBe('request failed (network)');
  });

  it('collapses any other error: no host, port, address or URL ever comes back', async () => {
    const leaky = new Error('connect ECONNREFUSED 10.0.0.5:25 via https://user:pw@internal.example.com/x?key=1');
    const report = await reportFor('webhook', leaky);
    expect(report).toBe('request failed (network)');
    const emailReport = await reportFor('email', Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:25'), { code: 'ESOCKET' }));
    expect(emailReport).toBe('request failed (network)');
    for (const text of [report, emailReport]) {
      expect(text).not.toMatch(/10\.0\.0\.5|internal|ECONNREFUSED|pw|key=/);
    }
  });

  it('keeps the two email answers that help an operator: authentication and timeout', async () => {
    expect(await reportFor('email', Object.assign(new Error('Invalid login: 535 5.7.8 for user@host'), { code: 'EAUTH' }))).toBe(
      'authentication failed',
    );
    expect(await reportFor('email', Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' }))).toBe(
      'request failed (timeout)',
    );
  });
});
