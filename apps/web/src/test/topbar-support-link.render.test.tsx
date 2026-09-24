import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';
import { SUPPORT_URL } from '@/lib/app';

const FIND_TIMEOUT_MS = 10_000;

/** The user menu carries the project's "Buy me a coffee" link: a real anchor that opens in a
 *  new tab with the safe rel, never a router navigation. */
describe('TopBar user menu "Buy me a coffee" link', () => {
  beforeEach(() => {
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
    if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
    if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  });

  it('is an external link to the support page', async () => {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const userMenuButton = await screen.findByRole('button', { name: 'User menu' }, { timeout: FIND_TIMEOUT_MS });
    fireEvent.pointerDown(userMenuButton, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.pointerUp(userMenuButton, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(userMenuButton);

    const link = await screen.findByRole('menuitem', { name: 'Buy me a coffee' }, { timeout: FIND_TIMEOUT_MS });
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', SUPPORT_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(SUPPORT_URL).toBe('https://www.buymeacoffee.com/c2tech');
  });
});
