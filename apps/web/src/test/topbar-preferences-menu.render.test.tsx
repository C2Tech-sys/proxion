import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';

/** Generous on purpose -- see tab-range-preservation.render.test.tsx for why. */
const FIND_TIMEOUT_MS = 5000;

/**
 * The user menu's "Preferences" item used to be permanently `disabled`. It now opens the
 * Preferences page -- covers both "the item itself is enabled" and "clicking it navigates".
 */
describe('TopBar user menu "Preferences" item', () => {
  beforeEach(() => {
    // jsdom doesn't implement the Pointer Events API Radix's DropdownMenu relies on to open --
    // minimal no-op polyfills so a real click on its trigger works here (same as
    // auth-gate.render.test.tsx's identical setup for the same menu).
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = () => false;
    }
    if (!Element.prototype.setPointerCapture) {
      Element.prototype.setPointerCapture = () => {};
    }
    if (!Element.prototype.releasePointerCapture) {
      Element.prototype.releasePointerCapture = () => {};
    }
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
  });

  it('is enabled and navigates to /preferences when clicked', async () => {
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

    const userMenuButton = await screen.findByRole(
      'button',
      { name: 'User menu' },
      { timeout: FIND_TIMEOUT_MS },
    );
    // Radix's trigger opens on `pointerdown`, not `click`.
    fireEvent.pointerDown(userMenuButton, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.pointerUp(userMenuButton, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(userMenuButton);

    const preferencesItem = await screen.findByRole(
      'menuitem',
      { name: 'Preferences' },
      { timeout: FIND_TIMEOUT_MS },
    );
    expect(preferencesItem).not.toHaveAttribute('data-disabled');

    fireEvent.click(preferencesItem);

    await waitFor(() => expect(router.state.location.pathname).toBe('/preferences'), {
      timeout: FIND_TIMEOUT_MS,
    });
    expect(
      await screen.findByRole('heading', { name: 'Preferences' }, { timeout: FIND_TIMEOUT_MS }),
    ).toBeInTheDocument();
  });
});
