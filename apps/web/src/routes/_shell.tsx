import { useEffect, useRef } from 'react';
import { createFileRoute, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import type { ImperativePanelHandle } from 'react-resizable-panels';

import { TopBar } from '@/components/TopBar';
import { DemoBanner } from '@/components/DemoBanner';
import { InventoryTree } from '@/components/InventoryTree';
import { TasksDrawer } from '@/components/TasksDrawer';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { useUiStore } from '@/store/ui';
import { useAuthMe } from '@/api/hooks';
import { usePrefs } from '@/api/prefsHooks';

export const Route = createFileRoute('/_shell')({
  component: ShellLayout,
});

/**
 * Auth gate for every route under this layout (dashboard, node/vm pages, tasks): an
 * unauthenticated visit (no session, and not token mode -- `useAuthMe`'s `data === null`)
 * redirects to `/login`, carrying the page the visitor actually asked for so login can return
 * them there. `data === undefined` (still loading) and a real identity both render the shell as
 * normal -- the former briefly, the latter because they're allowed in -- only a *settled* "no"
 * triggers the redirect, so a slow first `/api/auth/me` round-trip never flashes a redirect.
 */
function useAuthGate(): boolean {
  const { data: auth, isLoading, isFetching } = useAuthMe();
  const navigate = useNavigate();
  const location = useLocation();
  // Guards against re-navigating: `navigate()` is async, and this component can render again
  // (React Router's own pending-navigation state changes, StrictMode's double-invoke, ...)
  // before the route actually leaves `/_shell` -- without this, a second effect run would read
  // the *already-redirected-to* `/login?redirect=...` location and wrap it into a new redirect,
  // compounding on every re-render.
  const redirectedRef = useRef(false);
  // `data === null` also describes the brief window right after login invalidates this query
  // (see routes/login.tsx): the *previous* "not authenticated" answer lingers in `data` while
  // the invalidated refetch is in flight (`isLoading` alone is already `false` by then, since
  // the query settled once before). Waiting for `!isFetching` too avoids treating that stale
  // `null` as a fresh "no" and redirecting straight back to /login after a successful sign-in.
  const settled = !isLoading && !isFetching;

  useEffect(() => {
    if (settled && auth === null && !redirectedRef.current) {
      redirectedRef.current = true;
      void navigate({
        to: '/login',
        search: { redirect: location.pathname + location.searchStr },
        replace: true,
      });
    }
  }, [settled, auth, navigate, location.pathname, location.searchStr]);

  return settled && auth !== null && auth !== undefined;
}

/**
 * The panel group's actual rendered width, to convert the persisted pixel sidebar width to the
 * percentage `ResizablePanel` wants.
 *
 * This used to be a fixed `1440` reference: at any OTHER viewport width, that made the rail's
 * real on-screen pixel width drift from `sidebarWidth` (e.g. a 1024px-wide window rendered the
 * default rail at ~227px for a 320px setting -- 320/1440*1024). The panel group spans the full
 * viewport width (the shell has no horizontal padding, and the page never grows a horizontal
 * *or* vertical scrollbar of its own -- every tab scrolls internally, see route files), so
 * `window.innerWidth` at the moment we need it IS the group's real width, with no ResizeObserver
 * or ref measurement required. It's read fresh at each call site rather than cached in state:
 * `defaultSize` (below) is only honored by the library on the panel's own first mount anyway, so
 * a stale value from an earlier render couldn't matter there, and `onResize` (further down) is a
 * live callback that should always use the size at the moment of that specific resize.
 */
function viewportWidth(): number {
  return typeof window === 'undefined' ? 1440 : window.innerWidth;
}

function ShellLayout() {
  const authenticated = useAuthGate();
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const railRef = useRef<ImperativePanelHandle>(null);
  // The panel group hasn't necessarily finished registering this panel's layout the moment
  // this component's own mount effect runs (that registration is itself effect-driven, and a
  // panel's `collapse()`/`expand()`/`isCollapsed()` throw "Panel size not found" if called
  // before it has) -- so the initial `collapsed` value is applied declaratively instead, via
  // `defaultSize` below, and this ref only skips the *first* effect run, reacting to changes
  // (an actual toggle-button click) from then on, by which point layout is long since settled.
  const didMountRef = useRef(false);
  // Guards `railWidth` (the preference) so it's applied to the live rail exactly once, the
  // first time it resolves -- never re-fighting a resize the user performs afterward (that pref
  // only ever changes again from the Preferences page's own explicit write, e.g. "Reset to
  // default").
  const railWidthPrefAppliedRef = useRef(false);
  const { data: prefs } = usePrefs();

  const railSize = (sidebarWidth / viewportWidth()) * 100;

  useEffect(() => {
    if (railWidthPrefAppliedRef.current || !prefs?.railWidth) return;
    railWidthPrefAppliedRef.current = true;
    if (prefs.railWidth === sidebarWidth) return;
    setSidebarWidth(prefs.railWidth);
    const panel = railRef.current;
    if (panel && !panel.isCollapsed()) {
      panel.resize((prefs.railWidth / viewportWidth()) * 100);
    }
  }, [prefs?.railWidth, sidebarWidth, setSidebarWidth]);

  // Drive the collapsed state through react-resizable-panels' own collapse()/expand() API
  // instead of unmounting the panel (the previous `{!collapsed && <ResizablePanel/>}`). That
  // unmount threw away the library's internal drag-origin bookkeeping for the rail's handle
  // on every collapse, so a drag performed right after a collapse->expand round-trip measured
  // its delta from a stale origin and the rail jumped far from the pointer instead of tracking
  // it. Keeping the panel mounted keeps that bookkeeping intact across the round-trip.
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    const panel = railRef.current;
    if (!panel) return;
    if (collapsed && !panel.isCollapsed()) {
      panel.collapse();
    } else if (!collapsed && panel.isCollapsed()) {
      panel.expand();
    }
  }, [collapsed]);

  // Not authenticated (redirect effect above is already navigating to /login) or still waiting
  // on the first /api/auth/me round-trip: render nothing rather than flashing the real shell.
  if (!authenticated) return null;

  return (
    <div className="flex h-svh flex-col" data-density={prefs?.density ?? 'comfortable'}>
      <TopBar />
      <DemoBanner />
      <div className="min-h-0 flex-1">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel
            ref={railRef}
            defaultSize={collapsed ? 0 : railSize}
            minSize={12}
            maxSize={35}
            collapsible
            collapsedSize={0}
            // Persist ONLY user-initiated resizes. react-resizable-panels calls `onResize`
            // once on mount with `prevSize === undefined`; writing that mount layout back to
            // the store rounded the stored width down (e.g. 320 -> 316) on every page load. It
            // also fires on every collapse/expand (size 0 or back to the restored size) --
            // neither is a drag, so both are skipped too.
            onResize={(size, prevSize) => {
              if (prevSize === undefined) return;
              if (size === 0) return;
              setSidebarWidth(Math.round((size / 100) * viewportWidth()));
            }}
            className="border-r border-border"
          >
            <InventoryTree />
          </ResizablePanel>
          <ResizableHandle />
          {/* Sibling sizes must sum to exactly 100, or the group renormalises every panel and
              the rail lands a few pixels off the width the user actually chose. */}
          <ResizablePanel defaultSize={collapsed ? 100 : 100 - railSize}>
            <div className="flex h-full flex-col overflow-y-auto">
              <Outlet />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <TasksDrawer />
    </div>
  );
}
