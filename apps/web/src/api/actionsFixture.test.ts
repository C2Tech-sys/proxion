import { describe, expect, it } from 'vitest';

import { fixtureGuestAction } from '@/api/actionsFixture';
import { fixtureClient } from '@/api/fixtures';

describe('fixtureGuestAction', () => {
  it('resolves with a UPID-shaped string', async () => {
    const result = await fixtureGuestAction('pve1', 'qemu', 101, 'reboot');
    expect(result.upid).toMatch(/^UPID:pve1:/);
  });

  it('start flips a stopped guest to running', async () => {
    // vmid 103 (db-prod-02) starts stopped in the fixture.
    await expect(fixtureClient.getVmStatus('pve1', 'qemu', 103)).resolves.toMatchObject({
      status: 'stopped',
    });
    await fixtureGuestAction('pve1', 'qemu', 103, 'start');
    await expect(fixtureClient.getVmStatus('pve1', 'qemu', 103)).resolves.toMatchObject({
      status: 'running',
    });
  });

  it('stop/shutdown flip a running guest to stopped', async () => {
    await fixtureGuestAction('pve1', 'qemu', 101, 'stop');
    await expect(fixtureClient.getVmStatus('pve1', 'qemu', 101)).resolves.toMatchObject({
      status: 'stopped',
    });
  });

  it('suspend flips a running guest to paused, and resume flips it back to running', async () => {
    await fixtureGuestAction('pve1', 'qemu', 102, 'suspend');
    await expect(fixtureClient.getVmStatus('pve1', 'qemu', 102)).resolves.toMatchObject({
      status: 'paused',
    });

    await fixtureGuestAction('pve1', 'qemu', 102, 'resume');
    await expect(fixtureClient.getVmStatus('pve1', 'qemu', 102)).resolves.toMatchObject({
      status: 'running',
    });
  });

  it('reboot and reset leave the guest running', async () => {
    await fixtureGuestAction('pve1', 'qemu', 104, 'reboot');
    await expect(fixtureClient.getVmStatus('pve1', 'qemu', 104)).resolves.toMatchObject({
      status: 'running',
    });
  });
});
