import { describe, expect, it } from 'vitest';

import { fixtureUpdateGuestConfig } from '@/api/actionsFixture';
import { fixtureClient } from '@/api/fixtures';

describe('fixtureUpdateGuestConfig', () => {
  it('renames a qemu guest: config.name and the resource row both update', async () => {
    const result = await fixtureUpdateGuestConfig('pve1', 'qemu', 100, { name: 'web-01-renamed' });
    expect(result).toEqual({ ok: true, changed: ['name'] });

    await expect(fixtureClient.getVmConfig('pve1', 'qemu', 100)).resolves.toMatchObject({
      name: 'web-01-renamed',
    });
    const resources = await fixtureClient.getClusterResources();
    const resource = resources.find((r) => r.type === 'qemu' && r.vmid === 100);
    expect(resource?.name).toBe('web-01-renamed');
  });

  it('renames an lxc guest: config.hostname (not name) updates', async () => {
    // vmid 200 (caddy-proxy) is one of T31's second-fixture-node (pve2) guests -- `getVmConfig`
    // is keyed by vmid alone (node is only used by `setFixtureGuestConfig`'s own resource-row
    // lookup below), but the node passed here has to be the guest's real one for that lookup to
    // find it.
    const result = await fixtureUpdateGuestConfig('pve2', 'lxc', 200, { name: 'caddy-renamed' });
    expect(result).toEqual({ ok: true, changed: ['name'] });

    await expect(fixtureClient.getVmConfig('pve2', 'lxc', 200)).resolves.toMatchObject({
      hostname: 'caddy-renamed',
    });
    const resources = await fixtureClient.getClusterResources();
    const resource = resources.find((r) => r.type === 'lxc' && r.vmid === 200);
    expect(resource?.name).toBe('caddy-renamed');
  });

  it('updates description without touching the resource row name', async () => {
    const before = await fixtureClient.getClusterResources();
    const nameBefore = before.find((r) => r.type === 'qemu' && r.vmid === 101)?.name;

    const result = await fixtureUpdateGuestConfig('pve1', 'qemu', 101, { description: 'new notes' });
    expect(result).toEqual({ ok: true, changed: ['description'] });

    await expect(fixtureClient.getVmConfig('pve1', 'qemu', 101)).resolves.toMatchObject({
      description: 'new notes',
    });
    const after = await fixtureClient.getClusterResources();
    expect(after.find((r) => r.type === 'qemu' && r.vmid === 101)?.name).toBe(nameBefore);
  });

  it('reports both changed keys when both name and description are given', async () => {
    const result = await fixtureUpdateGuestConfig('pve1', 'qemu', 102, {
      name: 'db-renamed',
      description: 'db notes',
    });
    expect(result).toEqual({ ok: true, changed: ['name', 'description'] });
  });
});
