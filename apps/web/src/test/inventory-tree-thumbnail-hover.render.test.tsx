import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';

import { InventoryTree } from '@/components/InventoryTree';
import { createQueryClient } from '@/api/queryClient';
import type { PrefsResponse } from '@/api/prefs';

/**
 * Isolated from the real `ConsoleThumbnail` -- its own fetch/`IntersectionObserver` machinery is
 * covered by `ConsoleThumbnail.test.tsx`, and its `hover` variant by that same suite once this
 * ticket lands -- so this file only exercises `GuestThumbnailHover`'s own job: whether the card
 * shows at all, for which guests, and what it hands the tile. Same isolation strategy as
 * `dashboard-consoles-panel.render.test.tsx`'s mock of the same module.
 */
vi.mock('@/components/ConsoleThumbnail', () => ({
  ConsoleThumbnail: (props: { name: string; vmid: number; variant?: string }) => (
    <img
      alt={`Console preview for ${props.name}`}
      src={`data:image/svg+xml;utf8,fixture-${props.vmid}`}
      data-variant={props.variant}
    />
  ),
}));

/** `usePrefs()` mocked directly (rather than routed through fixture-mode `/api/prefs`) so each
 *  test can flip `consoleThumbnails` synchronously, with no `QueryClientProvider` round-trip to
 *  await. */
let prefsData: Partial<PrefsResponse> | undefined = { consoleThumbnails: true };
vi.mock('@/api/prefsHooks', () => ({
  usePrefs: () => ({ data: prefsData }),
}));

/** A permissive `matchMedia` stub -- unlike `test/setup.ts`'s own default (always `matches:
 *  false`, quiet for uPlot/theme sync) -- so `GuestThumbnailHover`'s fine-pointer check reads
 *  this device as capable of hovering, the default this whole suite needs. */
function stubFinePointerMatchMedia(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string): MediaQueryList =>
      ({
        matches,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

function buildTestRouter() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: InventoryTree,
  });
  const vmRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/vm/$node/$type/$vmid',
    validateSearch: (): { tab: string } => ({ tab: 'summary' }),
    component: () => <div>VM PAGE</div>,
  });
  const nodeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/node/$node',
    validateSearch: (): { tab: string } => ({ tab: 'summary' }),
    component: () => <div>NODE PAGE</div>,
  });
  const routeTree = rootRoute.addChildren([indexRoute, vmRoute, nodeRoute]);
  return createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) });
}

async function renderTree() {
  const queryClient = createQueryClient();
  const router = buildTestRouter();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByText('web-prod-01');
}

describe('Guest row console-thumbnail hover card', () => {
  beforeEach(() => {
    prefsData = { consoleThumbnails: true };
    stubFinePointerMatchMedia(true);
  });

  afterEach(() => {
    // Not every test in this file turns fake timers on (only the ones exercising the open/close
    // delays need to) -- guard the flush so the others don't hit "timers are not mocked".
    if (vi.isFakeTimers()) {
      act(() => {
        vi.runOnlyPendingTimers();
      });
      vi.useRealTimers();
    }
    vi.unstubAllGlobals();
  });

  it('hovering a running guest (web-prod-01, vmid 100) shows the card with an image and its caption', async () => {
    await renderTree();
    vi.useFakeTimers();

    fireEvent.pointerEnter(screen.getByText('web-prod-01'));
    act(() => {
      vi.advanceTimersByTime(400);
    });

    const card = screen.getByTestId('guest-thumbnail-hover-card');
    expect(within(card).getByRole('img', { name: 'Console preview for web-prod-01' })).toBeInTheDocument();
    expect(within(card).getByText('web-prod-01 · 100')).toBeInTheDocument();
  });

  it('a stopped guest (db-prod-02) shows no card on hover', async () => {
    await renderTree();
    vi.useFakeTimers();

    fireEvent.pointerEnter(screen.getByText('db-prod-02'));
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(screen.queryByTestId('guest-thumbnail-hover-card')).not.toBeInTheDocument();
  });

  it('shows no card when consoleThumbnails is off in preferences', async () => {
    prefsData = { consoleThumbnails: false };
    await renderTree();
    vi.useFakeTimers();

    fireEvent.pointerEnter(screen.getByText('web-prod-01'));
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(screen.queryByTestId('guest-thumbnail-hover-card')).not.toBeInTheDocument();
  });

  it('still opens the right-click context menu on a guest the hover card also covers', async () => {
    await renderTree();

    fireEvent.contextMenu(screen.getByText('web-prod-01'));
    const menu = await screen.findByRole('menu');

    expect(within(menu).getByRole('menuitem', { name: /^Open$/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Open console/ })).toBeInTheDocument();
  });

  it('keyboard focus on the row link shows the card immediately (no open delay)', async () => {
    await renderTree();

    fireEvent.focus(screen.getByText('web-prod-01'));

    const card = screen.getByTestId('guest-thumbnail-hover-card');
    expect(within(card).getByRole('img', { name: 'Console preview for web-prod-01' })).toBeInTheDocument();

    fireEvent.blur(screen.getByText('web-prod-01'));
    expect(screen.queryByTestId('guest-thumbnail-hover-card')).not.toBeInTheDocument();
  });
});
