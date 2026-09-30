import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GuestActionError } from '@/api/actions';
import { runWithConcurrency, splitBulkAction, sanitizeBulkActionError, type BulkGuest } from './bulkActions';

function guest(overrides: Partial<BulkGuest> = {}): BulkGuest {
  return { node: 'pve1', type: 'qemu', vmid: 100, name: 'g', status: 'running', template: false, ...overrides };
}

describe('splitBulkAction', () => {
  it('start: only a stopped, non-template guest is applicable', () => {
    const running = guest({ vmid: 1, status: 'running' });
    const stopped = guest({ vmid: 2, status: 'stopped' });
    const paused = guest({ vmid: 3, status: 'paused' });
    const template = guest({ vmid: 4, status: 'stopped', template: true });

    const { applicable, skipped } = splitBulkAction([running, stopped, paused, template], 'start');

    expect(applicable).toEqual([stopped]);
    expect(skipped).toEqual([
      { guest: running, reason: 'already running' },
      { guest: paused, reason: 'already running' },
      { guest: template, reason: 'template' },
    ]);
  });

  it('shutdown: only a running guest is applicable', () => {
    const running = guest({ vmid: 1, status: 'running' });
    const stopped = guest({ vmid: 2, status: 'stopped' });
    const paused = guest({ vmid: 3, status: 'paused' });
    const template = guest({ vmid: 4, status: 'running', template: true });

    const { applicable, skipped } = splitBulkAction([running, stopped, paused, template], 'shutdown');

    expect(applicable).toEqual([running]);
    expect(skipped).toEqual([
      { guest: stopped, reason: 'not running' },
      { guest: paused, reason: 'not running' },
      { guest: template, reason: 'template' },
    ]);
  });

  it('reboot: only a running guest is applicable', () => {
    const running = guest({ vmid: 1, status: 'running' });
    const stopped = guest({ vmid: 2, status: 'stopped' });

    const { applicable, skipped } = splitBulkAction([running, stopped], 'reboot');

    expect(applicable).toEqual([running]);
    expect(skipped).toEqual([{ guest: stopped, reason: 'not running' }]);
  });

  it('stop: a running or paused guest is applicable', () => {
    const running = guest({ vmid: 1, status: 'running' });
    const paused = guest({ vmid: 2, status: 'paused' });
    const stopped = guest({ vmid: 3, status: 'stopped' });
    const template = guest({ vmid: 4, status: 'running', template: true });

    const { applicable, skipped } = splitBulkAction([running, paused, stopped, template], 'stop');

    expect(applicable).toEqual([running, paused]);
    expect(skipped).toEqual([
      { guest: stopped, reason: 'not running' },
      { guest: template, reason: 'template' },
    ]);
  });

  it('a template is always skipped as "template", even when its status would otherwise qualify', () => {
    const stoppedTemplate = guest({ status: 'stopped', template: true });
    const { applicable, skipped } = splitBulkAction([stoppedTemplate], 'start');
    expect(applicable).toEqual([]);
    expect(skipped).toEqual([{ guest: stoppedTemplate, reason: 'template' }]);
  });
});

describe('runWithConcurrency', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never runs more than the given limit at once', async () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    let active = 0;
    let maxActive = 0;

    const resultPromise = runWithConcurrency(
      items,
      3,
      (item) =>
        new Promise<void>((resolve) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          setTimeout(
            () => {
              active -= 1;
              resolve();
            },
            item % 2 === 0 ? 20 : 10,
          );
        }),
    );

    await vi.runAllTimersAsync();
    const results = await resultPromise;

    expect(maxActive).toBeLessThanOrEqual(3);
    expect(results).toHaveLength(7);
    expect(results.every((r) => r.ok)).toBe(true);
    // Order is preserved regardless of completion order.
    expect(results.map((r) => r.item)).toEqual(items);
  });

  it('never rejects even when every item fails, and sanitises GuestActionError messages', async () => {
    const items = ['a', 'b', 'c'];

    const resultPromise = runWithConcurrency(items, 3, () =>
      Promise.reject(new GuestActionError(403, "You don't have VM.PowerMgmt on this guest")),
    );
    await vi.runAllTimersAsync();
    const results = await resultPromise;

    expect(results).toHaveLength(3);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results.every((r) => r.error === "You don't have VM.PowerMgmt on this guest")).toBe(true);
  });

  it('falls back to a generic message for a non-GuestActionError failure', async () => {
    const resultPromise = runWithConcurrency([1], 3, () => Promise.reject(new Error('boom')));
    await vi.runAllTimersAsync();
    const results = await resultPromise;

    expect(results).toEqual([{ item: 1, ok: false, error: 'The action could not be started.' }]);
  });

  it('with a limit larger than the item count, still runs every item exactly once', async () => {
    const resultPromise = runWithConcurrency([1, 2], 10, () => Promise.resolve());
    await vi.runAllTimersAsync();
    const results = await resultPromise;
    expect(results).toEqual([
      { item: 1, ok: true },
      { item: 2, ok: true },
    ]);
  });
});

describe('sanitizeBulkActionError', () => {
  it('returns a GuestActionError message unchanged', () => {
    expect(sanitizeBulkActionError(new GuestActionError(403, 'nope'))).toBe('nope');
  });

  it('returns a generic message for anything else', () => {
    expect(sanitizeBulkActionError(new Error('boom'))).toBe('The action could not be started.');
    expect(sanitizeBulkActionError('boom')).toBe('The action could not be started.');
  });
});
