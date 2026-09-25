import { describe, expect, it } from 'vitest';

import { fixtureCreateSnapshot, fixtureDeleteSnapshot, fixtureGuestAction, fixtureRollbackSnapshot } from '@/api/actionsFixture';
import { fixtureClient } from '@/api/fixtures';
import type { Snapshot } from '@/api/types';

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

describe('fixture snapshot mutations (create/delete/rollback)', () => {
  function byName(list: Snapshot[], name: string): Snapshot | undefined {
    return list.find((s) => s.name === name);
  }

  it('fixtureCreateSnapshot resolves with a UPID-shaped string and adds the snapshot', async () => {
    const before = await fixtureClient.getSnapshots('pve1', 'qemu', 106);
    expect(byName(before, 'new-snap')).toBeUndefined();

    const result = await fixtureCreateSnapshot('pve1', 'qemu', 106, {
      snapname: 'new-snap',
      description: 'a fresh one',
      vmstate: true,
    });
    expect(result.upid).toMatch(/^UPID:pve1:/);

    const after = await fixtureClient.getSnapshots('pve1', 'qemu', 106);
    expect(byName(after, 'new-snap')).toMatchObject({
      name: 'new-snap',
      description: 'a fresh one',
      vmstate: true,
    });
  });

  it('fixtureCreateSnapshot puts the new snapshot where "current" was, and moves "current" under it', async () => {
    const before = await fixtureClient.getSnapshots('pve1', 'qemu', 106);
    const previousCurrentParent = byName(before, 'current')?.parent;

    await fixtureCreateSnapshot('pve1', 'qemu', 106, { snapname: 'chain-check' });

    const after = await fixtureClient.getSnapshots('pve1', 'qemu', 106);
    expect(byName(after, 'chain-check')?.parent).toBe(previousCurrentParent);
    expect(byName(after, 'current')?.parent).toBe('chain-check');
  });

  it('fixtureDeleteSnapshot resolves with a UPID-shaped string and removes the snapshot', async () => {
    await fixtureCreateSnapshot('lxc-fixture-node', 'lxc', 200, { snapname: 'to-delete' });
    const before = await fixtureClient.getSnapshots('lxc-fixture-node', 'lxc', 200);
    expect(byName(before, 'to-delete')).toBeDefined();

    const result = await fixtureDeleteSnapshot('lxc-fixture-node', 'lxc', 200, 'to-delete');
    expect(result.upid).toMatch(/^UPID:lxc-fixture-node:/);

    const after = await fixtureClient.getSnapshots('lxc-fixture-node', 'lxc', 200);
    expect(byName(after, 'to-delete')).toBeUndefined();
  });

  it('fixtureDeleteSnapshot re-parents anything pointing at the deleted snapshot', async () => {
    // qemu-100's chain: pre-upgrade -> post-upgrade -> before-migration, current under before-migration.
    await fixtureDeleteSnapshot('pve1', 'qemu', 100, 'post-upgrade');

    const after = await fixtureClient.getSnapshots('pve1', 'qemu', 100);
    expect(byName(after, 'post-upgrade')).toBeUndefined();
    expect(byName(after, 'before-migration')?.parent).toBe('pre-upgrade');
  });

  it('fixtureRollbackSnapshot moves "current" under the chosen snapshot without touching the guest status', async () => {
    await expect(fixtureClient.getVmStatus('pve1', 'qemu', 106)).resolves.toMatchObject({ status: 'running' });

    const result = await fixtureRollbackSnapshot('pve1', 'qemu', 106, 'fresh-install');
    expect(result.upid).toMatch(/^UPID:pve1:/);

    const after = await fixtureClient.getSnapshots('pve1', 'qemu', 106);
    expect(byName(after, 'current')?.parent).toBe('fresh-install');
    await expect(fixtureClient.getVmStatus('pve1', 'qemu', 106)).resolves.toMatchObject({ status: 'running' });
  });

  it('fixtureRollbackSnapshot with start:true boots a stopped guest back up', async () => {
    await fixtureGuestAction('pve1', 'qemu', 103, 'stop');
    await expect(fixtureClient.getVmStatus('pve1', 'qemu', 103)).resolves.toMatchObject({ status: 'stopped' });

    await fixtureRollbackSnapshot('pve1', 'qemu', 103, 'some-snap', { start: true });

    await expect(fixtureClient.getVmStatus('pve1', 'qemu', 103)).resolves.toMatchObject({ status: 'running' });
  });
});
