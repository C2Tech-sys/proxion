import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';

/**
 * The Recent Tasks drawer used to show a "Log viewer not implemented: UPID..." toast when a
 * row was clicked, while /tasks and the Tasks tabs already opened the real `TaskLogSheet` for
 * the same data. The drawer now opens that same sheet.
 */
describe('Recent Tasks drawer opens the real log sheet', () => {
  it('opens TaskLogSheet (not a "not implemented" toast) when a row is clicked', async () => {
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

    // Open the drawer. The dashboard page behind it has its own `<Table>`s (cluster nodes, top
    // consumers), so every row-related query below is scoped to the drawer's own root element
    // (the toggle button's parent), not `screen` globally.
    const drawerToggle = await screen.findByRole('button', { name: /Recent Tasks/ });
    fireEvent.click(drawerToggle);
    const drawer = within(drawerToggle.parentElement!);

    // Click the first task row.
    const rows = await drawer.findAllByRole('row');
    // rows[0] is the header row; the first data row is next.
    fireEvent.click(rows[1]!);

    const dialog = await screen.findByRole('dialog');
    // The sheet's title is the task's UPID (a long, distinctive, monospace string) -- if it
    // opened, the dialog is non-empty and shows *something* task-shaped rather than nothing.
    expect(within(dialog).getByText(/UPID:/)).toBeInTheDocument();
    expect(screen.queryByText(/Log viewer not implemented/)).toBeNull();
  });
});
