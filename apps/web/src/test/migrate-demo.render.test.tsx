import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';
import { fixtureClient, setFixtureGuestNode } from '@/api/fixtures';

/**
 * T31: end-to-end demo coverage for the "Migrate…" action against real fixture data, now that
 * the fixture cluster has a second node (`pve2`) -- before this ticket, `otherNodeCount` was
 * always 0 in fixture mode and the "More" menu's Migrate item was permanently disabled ("No
 * other node to migrate to"), so this flow could never be exercised end-to-end in the demo.
 *
 * Route-level (real router, real fixture client, no mocks): opens the VM page for vmid 100
 * (web-prod-01, on pve1), drives the header's "More" menu -> "Migrate…" dialog exactly the way a
 * person would, confirms, and asserts the router lands on the guest's new URL under pve2 with
 * its `tab` search param preserved, and that the cluster resources fixture itself now reports
 * the guest on pve2 -- proving the fixture mutation (`setFixtureGuestNode`, via
 * `fixtureMigrateGuest`) and the post-migration navigation (`useMigrateGuest`, see
 * actionHooks.ts) both actually ran, not just the dialog UI.
 */
const FIND_TIMEOUT_MS = 10_000;

function renderAt(path: string) {
  const queryClient = createQueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

/** Radix's DropdownMenu/Select trigger opens on `pointerdown`, not `click` -- jsdom doesn't
 * implement the Pointer Events API they rely on, so a real interaction needs these no-op
 * polyfills plus firing pointerdown/pointerup ourselves first. Same convention as
 * `snapshots-tab.render.test.tsx`'s `openRowMenu` / `object-header-actions.render.test.tsx`. */
function openMoreMenu(trigger: HTMLElement) {
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
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.pointerUp(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

describe('Migrate demo, end to end (fixture mode, T31)', () => {
  afterEach(() => {
    // This test moves the shared in-memory fixture guest 100 to pve2 -- put it back so no other
    // test file sharing this module in the same worker sees it on the wrong node (same
    // convention as `migrate-guest.render.test.tsx`'s own fixture-mode restore).
    setFixtureGuestNode('pve2', 'qemu', 100, 'pve1');
  });

  it('opens the VM page, migrates web-prod-01 to pve2 via the More menu, and lands on its new URL', async () => {
    const router = renderAt('/vm/pve1/qemu/100?tab=summary');

    await screen.findByRole('heading', { name: 'web-prod-01' }, { timeout: FIND_TIMEOUT_MS });

    openMoreMenu(await screen.findByRole('button', { name: 'More actions' }, { timeout: FIND_TIMEOUT_MS }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Migrate/ }, { timeout: FIND_TIMEOUT_MS }));
    const dialog = await screen.findByRole('dialog', {}, { timeout: FIND_TIMEOUT_MS });

    // Wait for the fixture precheck (simulated network delay) to resolve and pve2 -- the only
    // other fixture node -- to become the default target, before inspecting the picker: until
    // then every node reads as ineligible ("Checking…").
    const confirmButton = within(dialog).getByRole('button', { name: 'Migrate' });
    await waitFor(() => expect(confirmButton).toBeEnabled(), { timeout: FIND_TIMEOUT_MS });

    // pve2 is listed, enabled, and already the default target (no picker interaction needed):
    // open the picker just to prove it's there and selectable.
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Target node' }));
    const options = await screen.findAllByRole('option', {}, { timeout: FIND_TIMEOUT_MS });
    const pve2Option = options.find((o) => o.textContent?.includes('pve2'));
    expect(pve2Option).toBeDefined();
    expect(pve2Option).not.toHaveAttribute('aria-disabled', 'true');
    expect(pve2Option).toHaveAttribute('aria-selected', 'true');
    // Close the picker back onto the already-selected default target.
    fireEvent.click(pve2Option!);

    fireEvent.click(confirmButton);

    await waitFor(
      () => {
        expect(router.state.location.pathname).toBe('/vm/pve2/qemu/100');
        expect(router.state.location.search).toMatchObject({ tab: 'summary' });
      },
      { timeout: FIND_TIMEOUT_MS },
    );

    // The heading re-renders for the guest's new object route, and the fixture's own cluster
    // resources now report it on pve2 -- the mutation, not just the URL, actually happened.
    await screen.findByRole('heading', { name: 'web-prod-01' }, { timeout: FIND_TIMEOUT_MS });
    const resources = await fixtureClient.getClusterResources();
    const moved = resources.find((r) => r.type === 'qemu' && r.vmid === 100);
    expect(moved?.node).toBe('pve2');
  });
});
