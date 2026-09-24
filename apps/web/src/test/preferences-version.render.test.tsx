import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';
import { APP_VERSION } from '@/version';

/** Generous on purpose -- see tab-range-preservation.render.test.tsx for why. */
const FIND_TIMEOUT_MS = 5000;

function renderPreferences() {
  const queryClient = createQueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/preferences'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('Preferences page: version', () => {
  it('shows the running Proxion version in the Account panel', async () => {
    renderPreferences();

    await screen.findByRole('heading', { name: 'Preferences' }, { timeout: FIND_TIMEOUT_MS });

    expect(screen.getByText(`Proxion v${APP_VERSION}`)).toBeInTheDocument();
  });
});
