import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';

/** Generous on purpose -- see tab-range-preservation.render.test.tsx for why. */
const FIND_TIMEOUT_MS = 5000;

describe('Top bar "All tasks" button toggle (T7)', () => {
  it('is not pressed on the dashboard, and navigates to /tasks when clicked', async () => {
    const queryClient = createQueryClient();
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const button = await screen.findByRole('button', { name: 'All tasks' }, { timeout: FIND_TIMEOUT_MS });
    expect(button).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(button);

    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'), {
      timeout: FIND_TIMEOUT_MS,
    });
    expect(await screen.findByRole('heading', { name: 'Tasks' }, { timeout: FIND_TIMEOUT_MS })).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('clicking it again while on /tasks goes back to the previous in-app route', async () => {
    const queryClient = createQueryClient();
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    // Navigate to a node page first, then to /tasks, both via in-app navigation, so there is a
    // real "previous route" for the button to return to.
    await router.navigate({ to: '/node/$node', params: { node: 'pve1' }, search: { tab: 'summary' } });
    await waitFor(() => expect(router.state.location.pathname).toBe('/node/pve1'));

    await router.navigate({ to: '/tasks' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'));

    const button = await screen.findByRole('button', { name: 'All tasks' }, { timeout: FIND_TIMEOUT_MS });
    expect(button).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(button);

    await waitFor(() => expect(router.state.location.pathname).toBe('/node/pve1'), {
      timeout: FIND_TIMEOUT_MS,
    });
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking it while on /tasks with no prior in-app route goes to /', async () => {
    const queryClient = createQueryClient();
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/tasks'] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const button = await screen.findByRole('button', { name: 'All tasks' }, { timeout: FIND_TIMEOUT_MS });
    expect(button).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(button);

    await waitFor(() => expect(router.state.location.pathname).toBe('/'), {
      timeout: FIND_TIMEOUT_MS,
    });
  });
});
