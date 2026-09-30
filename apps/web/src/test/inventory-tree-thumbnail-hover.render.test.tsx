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

    // Portaled straight to `document.body`, never as a descendant of the rail's own
    // `overflow-y-auto` container -- that container clips its x-axis overflow, so an in-flow
    // card nested inside it would silently get clipped the moment it didn't fit the rail's width
    // (jsdom can't see that clipping, which is exactly why this assertion exists).
    expect(document.body.contains(card)).toBe(true);
    expect(screen.getByRole('tree').contains(card)).toBe(false);

    // `position: fixed` with a computed, numeric `top`/`left` -- not the rail-relative
    // `position: absolute` that a nested card would use.
    expect(card.style.position).toBe('fixed');
    expect(Number.isFinite(parseFloat(card.style.top))).toBe(true);
    expect(Number.isFinite(parseFloat(card.style.left))).toBe(true);
  });

  it('clamps the card to stay inside a short viewport when the row sits near the bottom', async () => {
    await renderTree();
    vi.useFakeTimers();
    vi.stubGlobal('innerWidth', 1024);
    vi.stubGlobal('innerHeight', 200);

    // The row's own wrapping element (`GuestThumbnailHover`'s trigger `<div>`) is the direct DOM
    // parent of its `<a>` link -- `GuestContextMenu`'s Radix `ContextMenu.Root` renders no DOM
    // node of its own around it.
    const link = screen.getByText('web-prod-01').closest('a')!;
    const rowEl = link.parentElement!;
    vi.spyOn(rowEl, 'getBoundingClientRect').mockReturnValue({
      top: 190,
      left: 20,
      right: 300,
      bottom: 210,
      width: 280,
      height: 20,
      x: 20,
      y: 190,
      toJSON: () => ({}),
    });
    const rail = screen.getByRole('tree');
    vi.spyOn(rail, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      right: 300,
      bottom: 200,
      width: 300,
      height: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerEnter(screen.getByText('web-prod-01'));
    act(() => {
      vi.advanceTimersByTime(400);
    });

    const card = screen.getByTestId('guest-thumbnail-hover-card');
    const top = parseFloat(card.style.top);
    const left = parseFloat(card.style.left);

    // The row's own top (190) plus the card's (estimated) height would run well past a 200px-tall
    // viewport -- the card must be shifted up to the 8px-margin ceiling of its clamp range, not
    // left hanging off the bottom edge.
    expect(top).toBe(8);
    // Still placed to the right of the *rail's* right edge (300 + 6px gap), not the row's.
    expect(left).toBe(306);
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
