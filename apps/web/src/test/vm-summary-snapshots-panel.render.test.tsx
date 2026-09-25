import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';
import snapshotsFixture from '@/fixtures/snapshots.json';

const FIND_TIMEOUT_MS = 10_000;

/**
 * The Summary tab's Snapshots panel used to be a read-only placeholder ("0 snapshots." with a
 * permanently disabled button) even after the Snapshots tab gained real actions. It now reads
 * the guest's snapshots and opens the same create dialog as the tab.
 */
describe('VM Summary: Snapshots panel (fixture mode)', () => {
  it('shows the real snapshot count for VM 100 and an enabled Take snapshot that opens the dialog', async () => {
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/vm/pve1/qemu/100?tab=summary'] }),
    });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const button = await screen.findByRole('button', { name: /Take snapshot/ }, { timeout: FIND_TIMEOUT_MS });
    expect(button).not.toBeDisabled();

    const fixture = (snapshotsFixture as Record<string, { name: string }[]>)['qemu-100'] ?? [];
    const real = fixture.filter((s) => s.name !== 'current').length;
    if (real > 0) {
      expect(
        await screen.findByText(new RegExp(`^${real} snapshots? \\u00b7 open the Snapshots tab$`), {}, {
          timeout: FIND_TIMEOUT_MS,
        }),
      ).toBeInTheDocument();
    } else {
      expect(await screen.findByText('No snapshots yet.', {}, { timeout: FIND_TIMEOUT_MS })).toBeInTheDocument();
    }

    fireEvent.click(button);
    expect(await screen.findByRole('dialog', {}, { timeout: FIND_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
  });
});
