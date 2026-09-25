import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';

/** Generous on purpose -- this is a route-level render test against fixture data (see
 *  tab-range-preservation.render.test.tsx for the same reasoning). */
const FIND_TIMEOUT_MS = 5000;

function renderGuests(initialEntry = '/guests') {
  const queryClient = createQueryClient();
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [initialEntry] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('GuestsPage (T25)', () => {
  it('renders a heading and every fixture guest as a row', async () => {
    renderGuests();
    await screen.findByRole('heading', { name: 'Guests' }, { timeout: FIND_TIMEOUT_MS });

    const table = await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });
    // 21 fixture guests (see fixtures/resources.json) + 1 header row.
    const rows = within(table).getAllByRole('row');
    expect(rows.length).toBe(22);
    expect(within(table).getByText('web-prod-01')).toBeInTheDocument();
  });

  it('shows the "<n> of <total> shown · <running> running" subtitle', async () => {
    renderGuests();
    await screen.findByRole('heading', { name: 'Guests' }, { timeout: FIND_TIMEOUT_MS });
    await screen.findByText(/21 of 21 shown/, {}, { timeout: FIND_TIMEOUT_MS });
  });

  it('filters by type via the URL search (?type=lxc)', async () => {
    renderGuests('/guests?type=lxc');
    const table = await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });
    await screen.findByText(/of 21 shown/, {}, { timeout: FIND_TIMEOUT_MS });
    // caddy-proxy is one of the fixture's lxc containers.
    expect(within(table).getByText('caddy-proxy')).toBeInTheDocument();
    expect(within(table).queryByText('web-prod-01')).not.toBeInTheDocument();
  });

  it('filters by status via the URL search (?status=stopped)', async () => {
    renderGuests('/guests?status=stopped');
    const table = await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });
    // db-prod-02 is a stopped fixture guest (see inventory-tree-actions.render.test.tsx). The
    // inventory rail renders alongside the page and also shows every guest, so queries here are
    // scoped to the Guests table itself.
    await within(table).findByText('db-prod-02', {}, { timeout: FIND_TIMEOUT_MS });
    expect(within(table).queryByText('web-prod-01')).not.toBeInTheDocument();
  });

  it('filters by node via the URL search', async () => {
    renderGuests('/guests?node=pve1');
    const table = await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });
    // Every fixture guest is on pve1, so filtering by it keeps the full 21 -- combined with a
    // bogus node it should show none.
    await screen.findByText(/21 of 21 shown/, {}, { timeout: FIND_TIMEOUT_MS });
    expect(within(table).getByText('web-prod-01')).toBeInTheDocument();
  });

  it('shows an empty state when the search matches nothing', async () => {
    renderGuests('/guests?q=no-such-guest-xyz');
    await screen.findByRole('heading', { name: 'Guests' }, { timeout: FIND_TIMEOUT_MS });
    await screen.findByText('No guests match the current filters.', {}, { timeout: FIND_TIMEOUT_MS });
  });

  it('sorts by name descending when the Name header is toggled twice', async () => {
    renderGuests('/guests?sort=name&dir=desc');
    const table = await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });
    const bodyRows = within(table).getAllByRole('row').slice(1);
    const firstRowName = within(bodyRows[0]!).getAllByRole('link')[0]?.textContent;
    const lastRowName = within(bodyRows.at(-1)!).getAllByRole('link')[0]?.textContent;
    expect(firstRowName! > lastRowName!).toBe(true);
  });

  it('sorts by memory (?sort=mem&dir=desc) with every running guest before every stopped one', async () => {
    renderGuests('/guests?sort=mem&dir=desc');
    const table = await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });
    const bodyRows = within(table).getAllByRole('row').slice(1);
    // Each row's status dot carries its PVE status as a `title` (see StatusDot.tsx) -- T25's
    // "stopped guests sort after running for cpu/mem/uptime" rule means once a non-running row
    // appears, every row after it must also be non-running.
    const statuses = bodyRows.map((row) => row.querySelector('[role="img"]')?.getAttribute('title'));
    const firstNonRunningIndex = statuses.findIndex((s) => s !== 'running');
    expect(firstNonRunningIndex).toBeGreaterThan(-1);
    expect(statuses.slice(firstNonRunningIndex)).not.toContain('running');
  });

  it("a guest row's name link points at its own object route", async () => {
    renderGuests();
    const table = await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });
    const link = within(table).getByText('web-prod-01').closest('a');
    expect(link).toHaveAttribute('href', expect.stringContaining('/vm/pve1/qemu/100'));
  });

  it('a focused row opens the guest on Enter', async () => {
    const router = renderGuests();
    const table = await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });
    const nameCell = within(table).getByText('web-prod-01');
    const row = nameCell.closest('tr')!;
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/vm/pve1/qemu/100'), {
      timeout: FIND_TIMEOUT_MS,
    });
  });

  it('Breadcrumbs show Datacenter › Guests', async () => {
    renderGuests();
    await screen.findByRole('heading', { name: 'Guests' }, { timeout: FIND_TIMEOUT_MS });
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByText('Datacenter')).toBeInTheDocument();
    expect(within(nav).getByText('Guests')).toBeInTheDocument();
  });
});
