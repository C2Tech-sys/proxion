import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { ConsolesPanel } from '@/pages/dashboard/DashboardPage';
import { createQueryClient } from '@/api/queryClient';
import type { ClusterResource } from '@/api/types';

/**
 * Isolated from the real `ConsoleThumbnail` (its own fetch/IntersectionObserver machinery is
 * covered by ConsoleThumbnail.test.tsx) so this only exercises the panel's own job: which
 * guests it shows, in what order, and whether it renders at all.
 */
vi.mock('@/components/ConsoleThumbnail', () => ({
  ConsoleThumbnail: (props: { name: string; vmid: number; refreshToken?: number }) => (
    <div data-testid="console-thumbnail" data-refresh-token={props.refreshToken}>
      {props.name} #{props.vmid}
    </div>
  ),
}));

function guest(overrides: Partial<ClusterResource> & { vmid: number }): ClusterResource {
  return {
    id: `qemu/${overrides.vmid}`,
    type: 'qemu',
    node: 'pve1',
    status: 'running',
    ...overrides,
  };
}

/** `ConsolesPanel` now reads the `consoleThumbnails` preference via `usePrefs()`
 *  (`useAuthMe()` underneath), which needs a `QueryClientProvider` in scope even though these
 *  tests never await it: on the synchronous first render `usePrefs()`'s data is `undefined`
 *  (nothing has resolved yet), which the panel treats the same as "on". */
function renderPanel(resources: ClusterResource[]) {
  const queryClient = createQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ConsolesPanel resources={resources} />
    </QueryClientProvider>,
  );
}

describe('Dashboard Consoles panel', () => {
  it('renders nothing when there are no running guests', () => {
    const { container } = renderPanel([
      guest({ vmid: 100, name: 'stopped-1', status: 'stopped' }),
      guest({ vmid: 110, name: 'a-template', status: 'running', template: 1 }),
    ]);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows one tile per running, non-template guest (qemu and lxc), sorted by name', () => {
    renderPanel([
      guest({ vmid: 102, name: 'zeta', status: 'running' }),
      guest({ vmid: 200, name: 'alpha-ct', status: 'running', type: 'lxc' }),
      guest({ vmid: 105, name: 'stopped', status: 'stopped' }),
      guest({ vmid: 110, name: 'tpl', status: 'running', template: 1 }),
    ]);

    expect(screen.getByText('Consoles (2)')).toBeInTheDocument();
    const tiles = screen.getAllByTestId('console-thumbnail');
    expect(tiles.map((t) => t.textContent)).toEqual(['alpha-ct #200', 'zeta #102']);
  });

  it('"Refresh all" bumps every tile\'s refreshToken', () => {
    renderPanel([guest({ vmid: 100, name: 'web-prod-01', status: 'running' })]);

    expect(screen.getByTestId('console-thumbnail')).toHaveAttribute('data-refresh-token', '0');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh all' }));
    expect(screen.getByTestId('console-thumbnail')).toHaveAttribute('data-refresh-token', '1');
  });
});
