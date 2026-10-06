import { describe, expect, it } from 'vitest';

import { getNextId, listContainerTemplates, listIsos, listNodes, listStoragesWithContent } from '@/api/create';
import { getFixtureNextId } from '@/api/fixtures';

// Fixture (demo) mode, this suite's default per `.env.test`: no network, answers from the bundled
// fixtures. The real-mode URLs are covered in create.test.ts.
describe('create reads in fixture mode', () => {
  it('getNextId is one past the highest fixture vmid', async () => {
    const id = await getNextId();
    expect(id).toBe(getFixtureNextId());
    expect(id).toBeGreaterThan(100);
  });

  it('listIsos / listContainerTemplates split the storage content by type', async () => {
    const isos = await listIsos('pve1', 'local');
    expect(isos.length).toBeGreaterThan(0);
    expect(isos.every((m) => m.volid.startsWith('local:iso/'))).toBe(true);
    expect(isos[0]?.size).toBeGreaterThan(0);

    const templates = await listContainerTemplates('pve1', 'local');
    expect(templates.length).toBeGreaterThan(0);
    expect(templates.every((m) => m.volid.startsWith('local:vztmpl/'))).toBe(true);
  });

  it('listStoragesWithContent filters the fixture storages by node and content', async () => {
    expect((await listStoragesWithContent('pve1', 'images')).map((s) => s.id)).toEqual(['local-zfs', 'tank']);
    expect((await listStoragesWithContent('pve1', 'iso')).map((s) => s.id)).toEqual(['local']);
    expect((await listStoragesWithContent('pve2', 'vztmpl')).map((s) => s.id)).toEqual(['local']);
    expect(await listStoragesWithContent('nope', 'images')).toEqual([]);
  });

  it('listNodes returns the fixture nodes', async () => {
    const nodes = await listNodes();
    expect(nodes.map((n) => n.name)).toEqual(['pve1', 'pve2']);
    expect(nodes.every((n) => n.status === 'online')).toBe(true);
  });
});
