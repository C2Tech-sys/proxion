import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';
import {
  getFixtureGuestConfig,
  patchFixtureGuestConfig,
  reorderFixtureClusterResources,
  reorderFixtureGuestConfigKeys,
  resetFixtureClusterResources,
  resetFixtureGuestConfigKeys,
} from '@/api/fixtures';

/** Several fixture-client queries (status, config, agent, rrd, resources) stack their simulated
 *  delays past the default 1000ms `findBy*` timeout -- see vm-summary-last-backup.render.test.tsx. */
const FIND_TIMEOUT_MS = 10_000;

/**
 * T77: the VM Summary "Related" panel (and the Hardware panel's Disks / Network lists) jumped
 * around because they rendered in the order Proxmox returns things -- the config JSON's key order
 * and `/cluster/resources`' row order, neither of which is stable between polls. The checked-in
 * fixture guest 100 has every disk on `tank` and every NIC on `vmbr0`, so each test below first
 * gives it a second storage and a second bridge whose names sort the OPPOSITE way round to the
 * config's key order (scsi0 on `tank` comes before scsi2 on `local-zfs`; net0 on `vmbr1` comes
 * before net1 on `vmbr0`).
 */
const ORIGINAL_NET0 = String(getFixtureGuestConfig(100)?.net0);

function addSecondStorageAndBridge() {
  patchFixtureGuestConfig('pve1', 'qemu', 100, {
    scsi2: 'local-zfs:vm-100-disk-5,size=8G',
    net0: 'virtio=BC:24:11:64:00:01,bridge=vmbr1',
  });
}

function restoreGuest100() {
  patchFixtureGuestConfig('pve1', 'qemu', 100, { scsi2: undefined, net0: ORIGINAL_NET0 });
}

function renderSummary(vmid: number) {
  const queryClient = createQueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [`/vm/pve1/qemu/${vmid}`] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** The Related panel's links, top to bottom, as rendered text. */
async function relatedLinks(): Promise<string[]> {
  const heading = await screen.findByRole('heading', { name: 'Related' }, { timeout: FIND_TIMEOUT_MS });
  return within(heading.closest('section') as HTMLElement)
    .getAllByRole('link')
    .map((a) => a.textContent ?? '');
}

/** The Hardware panel's `bus · storage` disk rows and NIC MACs, in document order. */
async function hardwareLists(): Promise<{ disks: string[]; macs: string[] }> {
  const heading = await screen.findByRole('heading', { name: 'Hardware' }, { timeout: FIND_TIMEOUT_MS });
  const panel = within(heading.closest('section') as HTMLElement);
  const diskList = panel.getByText('Disks').nextElementSibling as HTMLElement;
  const disks = Array.from(diskList.querySelectorAll('li > span:first-child')).map((el) =>
    (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );
  return { disks, macs: panel.getAllByTestId('summary-mac').map((el) => el.textContent ?? '') };
}

const SORTED_RELATED = [
  'storage/local-zfs',
  'storage/tank',
  'bridge/vmbr0',
  'bridge/vmbr1',
  'backups (local)',
  'backups (tank-backups)',
];

describe('VM Summary: Related panel order (T77)', () => {
  beforeEach(() => {
    resetFixtureClusterResources();
    resetFixtureGuestConfigKeys();
    addSecondStorageAndBridge();
  });

  afterEach(() => {
    cleanup();
    resetFixtureClusterResources();
    restoreGuest100();
    resetFixtureGuestConfigKeys();
  });

  it('lists storages, then bridges, then backups, each alphabetically (config keys are tank-first, vmbr1-first)', async () => {
    // Guard: the config's own key order puts `tank` (scsi0) before `local-zfs` (scsi2), so the
    // sorted output proves a real sort rather than a coincidence of the fixture.
    const keys = Object.keys(getFixtureGuestConfig(100) ?? {});
    expect(keys.indexOf('scsi0')).toBeLessThan(keys.indexOf('scsi2'));
    renderSummary(100);
    expect(await relatedLinks()).toStrictEqual(SORTED_RELATED);
  });

  it('is identical after the config keys and the cluster resources arrive reversed', async () => {
    reorderFixtureGuestConfigKeys('pve1', 'qemu', 100, 'reverse');
    reorderFixtureClusterResources('reverse');
    // Guard: the reorder really changed the config's key order.
    const keys = Object.keys(getFixtureGuestConfig(100) ?? {});
    expect(keys.indexOf('scsi2')).toBeLessThan(keys.indexOf('scsi0'));
    renderSummary(100);
    expect(await relatedLinks()).toStrictEqual(SORTED_RELATED);
  });

  it('is identical after a seeded shuffle of both the config keys and the cluster resources', async () => {
    const before = Object.keys(getFixtureGuestConfig(100) ?? {});
    reorderFixtureGuestConfigKeys('pve1', 'qemu', 100, 'shuffle(7)');
    reorderFixtureClusterResources('shuffle(11)');
    // Guard: the shuffle really moved keys (same keys, different insertion order).
    const after = Object.keys(getFixtureGuestConfig(100) ?? {});
    expect(after).not.toStrictEqual(before);
    expect([...after].sort()).toStrictEqual([...before].sort());
    renderSummary(100);
    expect(await relatedLinks()).toStrictEqual(SORTED_RELATED);
  });

  it('lists a storage once when two disks share it (vmid 106: scsi0 and scsi1 both on tank)', async () => {
    renderSummary(106);
    expect(await relatedLinks()).toStrictEqual([
      'storage/tank',
      'bridge/vmbr0',
      'backups (local)',
      'backups (tank-backups)',
    ]);
  });

  it('keeps the Hardware panel disks and NICs in natural order (scsi0, scsi1, scsi2 / net0, net1) when the keys arrive reversed', async () => {
    reorderFixtureGuestConfigKeys('pve1', 'qemu', 100, 'reverse');
    renderSummary(100);
    const { disks, macs } = await hardwareLists();
    expect(disks).toStrictEqual(['scsi · tank', 'scsi · tank', 'scsi · local-zfs']);
    expect(macs).toStrictEqual(['BC:24:11:64:00:01', 'BC:24:11:64:00:02']);
  });
});
