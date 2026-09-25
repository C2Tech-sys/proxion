import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';

/** Generous on purpose -- this is a route-level render test against fixture data (see
 *  guests-page.render.test.tsx for the same reasoning). */
const FIND_TIMEOUT_MS = 5000;

function renderStorage(initialEntry: string) {
  const queryClient = createQueryClient();
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [initialEntry] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('StoragePage (T28)', () => {
  it('renders the breadcrumb, name and type-chip counts for pve1/local', async () => {
    renderStorage('/storage/pve1/local');

    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' }, { timeout: FIND_TIMEOUT_MS });
    expect(within(nav).getByText('Datacenter')).toBeInTheDocument();
    expect(within(nav).getByText('pve1')).toBeInTheDocument();
    expect(within(nav).getByText('local')).toBeInTheDocument();

    await screen.findByRole('heading', { name: 'local' }, { timeout: FIND_TIMEOUT_MS });

    // pve1/local's fixture content (storage-content.json): 3 iso, 2 vztmpl, 1 backup = 6 total.
    await screen.findByRole('button', { name: 'All (6)' }, { timeout: FIND_TIMEOUT_MS });
    expect(screen.getByRole('button', { name: 'ISO images (3)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'CT templates (2)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Backups (1)' })).toBeInTheDocument();
    // No rootdir/images/snippets content on this storage -- those chips must not render.
    expect(screen.queryByRole('button', { name: /CT volumes/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disk images/ })).not.toBeInTheDocument();

    const table = await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });
    expect(within(table).getAllByRole('row')).toHaveLength(7); // 6 content rows + 1 header row.
  });

  it('?type=iso narrows the table to only ISO rows', async () => {
    renderStorage('/storage/pve1/local?type=iso');

    const table = await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4); // 3 iso rows + 1 header row.
    expect(within(table).getByText(/debian-12\.7\.0-amd64-netinst\.iso/)).toBeInTheDocument();
    expect(within(table).queryByText(/vzdump-lxc/)).not.toBeInTheDocument();
  });

  it('?q= narrows by volume id / notes', async () => {
    renderStorage('/storage/pve1/local?q=virtio');

    const table = await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(2); // 1 matching row + header.
    expect(within(table).getByText(/virtio-win/)).toBeInTheDocument();
  });

  it("a backup row's owner links to the guest page", async () => {
    renderStorage('/storage/pve1/local?type=backup');

    const table = await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });
    // vmid 201 (pihole, an lxc on pve1) owns the one backup in this fixture storage.
    const link = await within(table).findByRole('link', { name: '201' }, { timeout: FIND_TIMEOUT_MS });
    expect(link).toHaveAttribute('href', expect.stringContaining('/vm/pve1/lxc/201'));
  });

  it('shows a not-found state for a storage that does not exist on the node', async () => {
    renderStorage('/storage/pve1/does-not-exist');

    await screen.findByText(/was not found/i, {}, { timeout: FIND_TIMEOUT_MS });
    expect(screen.getByRole('link', { name: /back to node/i })).toBeInTheDocument();
  });
});
