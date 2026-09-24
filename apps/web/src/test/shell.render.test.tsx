import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';

/**
 * Renders the full app shell in fixture mode (VITE_USE_FIXTURES=1, see .env.test) at "/" and
 * checks that the top bar and the dashboard's cluster totals show up once fixtures resolve.
 */
describe('App shell (fixture mode)', () => {
  it('renders the top bar and dashboard totals', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('PROXION')).toBeInTheDocument();
    expect(await screen.findByText('Nodes')).toBeInTheDocument();
    expect(await screen.findByText('Virtual machines')).toBeInTheDocument();
    expect(await screen.findByRole('tree', { name: 'Inventory' })).toBeInTheDocument();
  });
});
