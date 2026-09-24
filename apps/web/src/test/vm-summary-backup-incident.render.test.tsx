import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';

// See vm-summary-last-backup.render.test.tsx's own copy of this constant for why.
const FIND_TIMEOUT_MS = 5000;

function renderVm(path: string) {
  const queryClient = createQueryClient();
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/**
 * T23: the "Last backup" panel's extra backup-incident line, sourced from `useAlerts()` filtered
 * to this guest -- see SummaryTab.tsx and the fixture backup-incident demo data (VMIDs 300-305)
 * added to fixtures/{tasks,resources}.json.
 */
describe('VM Summary "Last backup" panel: backup-incident line (fixture mode, T23)', () => {
  it('shows the muted "healed" line for a guest whose latest incident healed (vmid 300)', async () => {
    renderVm('/vm/pve1/qemu/300');

    const heading = await screen.findByRole('heading', { name: 'Last backup' }, { timeout: FIND_TIMEOUT_MS });
    const panel = within(heading.closest('section')!);

    expect(
      await panel.findByText(/^Previous attempt failed at \d{2}:\d{2} · healed by retry at \d{2}:\d{2}$/, undefined, {
        timeout: FIND_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
  });

  it('shows the same wording as the alerts strip for a soft (warning) incident (vmid 305)', async () => {
    renderVm('/vm/pve1/qemu/305');

    const heading = await screen.findByRole('heading', { name: 'Last backup' }, { timeout: FIND_TIMEOUT_MS });
    const panel = within(heading.closest('section')!);

    expect(
      await panel.findByText(/Backup of search-prod-01 \(305\) failed at \d{2}:\d{2} — retry in progress/, undefined, {
        timeout: FIND_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
  });

  it('shows the same wording as the alerts strip for a hard (error) incident (vmid 304)', async () => {
    renderVm('/vm/pve1/qemu/304');

    const heading = await screen.findByRole('heading', { name: 'Last backup' }, { timeout: FIND_TIMEOUT_MS });
    const panel = within(heading.closest('section')!);

    expect(
      await panel.findByText('Backup of queue-worker-01 (304) failed 3 times tonight', undefined, {
        timeout: FIND_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
  });

  it('shows no backup-incident line for a guest with no open/healed incident (vmid 100)', async () => {
    renderVm('/vm/pve1/qemu/100');

    const heading = await screen.findByRole('heading', { name: 'Last backup' }, { timeout: FIND_TIMEOUT_MS });
    const panel = within(heading.closest('section')!);
    await panel.findByText('Started', undefined, { timeout: FIND_TIMEOUT_MS });

    expect(panel.queryByText(/Previous attempt failed/)).toBeNull();
    expect(panel.queryByText(/waiting for a retry/)).toBeNull();
  });
});
