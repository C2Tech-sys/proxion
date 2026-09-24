import { useMemo } from 'react';
import { Link, useLocation, useRouter } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Activity,
  Coffee,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  UserRound,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Logo } from '@/components/Logo';
import { useClusterResources, useTasks, useAuthMe, AUTH_ME_QUERY_KEY } from '@/api/hooks';
import { useThemePreferenceSync } from '@/api/prefsHooks';
import { api } from '@/api/client';
import { errorMessage } from '@/api/errors';
import { useUiStore } from '@/store/ui';
import { cn } from '@/lib/utils';
import { APP_NAME, SUPPORT_URL } from '@/lib/app';

function useClusterHealth() {
  const { data: resources } = useClusterResources();
  return useMemo(() => {
    if (!resources) return { label: 'Unknown', tone: 'muted' as const };
    const nodes = resources.filter((r) => r.type === 'node');
    const offline = nodes.some((n) => n.status !== 'online');
    const anyError = resources.some((r) => r.status?.startsWith('ERROR'));
    if (offline || anyError) return { label: 'Degraded', tone: 'error' as const };
    return { label: 'Healthy', tone: 'ok' as const };
  }, [resources]);
}

export function TopBar() {
  // Applies `prefs.theme` once it resolves (system-vs-explicit, live media-query updates) --
  // see prefsHooks.ts. Called once here, high in the always-mounted authenticated shell, rather
  // than from every page that happens to render.
  useThemePreferenceSync();

  const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const tasksDrawerOpen = useUiStore((s) => s.tasksDrawerOpen);
  const setTasksDrawerOpen = useUiStore((s) => s.setTasksDrawerOpen);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebarCollapsed = useUiStore((s) => s.toggleSidebarCollapsed);
  const health = useClusterHealth();
  const { data: tasks } = useTasks();
  const runningCount = tasks?.filter((t) => t.status === 'running').length ?? 0;
  const router = useRouter();
  const location = useLocation();
  const onTasksRoute = location.pathname === '/tasks';
  const { data: auth } = useAuthMe();
  const queryClient = useQueryClient();

  // Toggle, not a plain link: on `/tasks` it acts like a "back" button (to wherever the user
  // came from in-app, or `/` if there is nowhere to go back to); everywhere else it's forward
  // navigation to `/tasks`. `aria-pressed` mirrors which of those two states we're in.
  function handleTasksNavClick() {
    if (onTasksRoute) {
      if (router.history.canGoBack()) {
        router.history.back();
      } else {
        void router.navigate({ to: '/' });
      }
    } else {
      void router.navigate({ to: '/tasks' });
    }
  }

  async function handleLogout() {
    try {
      await api.logout();
    } catch (error) {
      toast.error(errorMessage(error));
      return;
    }
    await queryClient.invalidateQueries({ queryKey: AUTH_ME_QUERY_KEY });
    void router.navigate({ to: '/login' });
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-3">
      <Button
        variant="ghost"
        size="icon"
        aria-label={sidebarCollapsed ? 'Show inventory' : 'Hide inventory'}
        onClick={toggleSidebarCollapsed}
      >
        {sidebarCollapsed ? (
          <PanelLeftOpen className="size-4" />
        ) : (
          <PanelLeftClose className="size-4" />
        )}
      </Button>

      {/*
       * Wordmark, in Josefin Sans (the display face -- see index.css's `--font-display`):
       * uppercase, `font-semibold` (600, the variable font's own weight axis) and
       * `tracking-[0.18em]` per the design brief's reference look. Sized and vertically
       * centered against the search box next to it (both sit in this flex row's shared
       * `items-center` baseline). Explicit `text-[16px]` (T10b, finding 1) rather than
       * `text-sm`: with `.font-display`'s own `font-size-adjust: none` (see index.css), Josefin
       * now renders at its declared size instead of `body`'s Open-Sans-tuned adjust inflating it
       * ~1.42x, so the size needs to be set for how it actually looks now, not for how the old
       * (buggy) 14px happened to look once inflated to ~20px.
       */}
      <Link
        to="/"
        aria-label={`${APP_NAME} home`}
        className="inline-flex shrink-0 items-center gap-2 font-display text-[16px] font-semibold tracking-[0.18em]"
      >
        <Logo className="size-5" />
        {/* Josefin sits high on its em box; nudge the text so it centres optically on the mark. */}
        <span className="pt-[0.14em]">{APP_NAME.toUpperCase()}</span>
      </Link>

      {/* `min-w-0` lets this shrink below its content's natural width in a tight flex row
          instead of forcing the placeholder to wrap (T10b, finding 2); the placeholder itself
          is short enough to fit the `max-w-xs` box down to the narrowest viewport this app
          targets (1024px) without truncating. */}
      <button
        type="button"
        onClick={() => setCommandPaletteOpen(true)}
        className="ml-2 flex h-7 max-w-xs min-w-0 flex-1 items-center gap-2 rounded-md border border-input bg-background px-2 text-xs text-muted-foreground outline-none hover:bg-accent/10 focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-label="Open command palette"
      >
        <Search className="size-3.5 shrink-0" />
        <span className="flex-1 truncate text-left">
          <span className="hidden lg:inline">Search nodes, VMs, storage&hellip;</span>
          <span className="lg:hidden">Search&hellip;</span>
        </span>
        <kbd className="shrink-0 rounded border border-border bg-muted px-1 font-sans text-[10px]">
          Ctrl K
        </kbd>
      </button>

      <div className="flex-1" />

      <div
        className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs"
        aria-label={`Cluster health: ${health.label}`}
      >
        <span
          className={cn(
            'size-1.5 rounded-full',
            health.tone === 'ok' && 'bg-status-running',
            health.tone === 'error' && 'bg-status-error',
            health.tone === 'muted' && 'bg-status-stopped',
          )}
        />
        {health.label}
      </div>

      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 text-xs"
        aria-pressed={tasksDrawerOpen}
        onClick={() => setTasksDrawerOpen(!tasksDrawerOpen)}
      >
        <Activity className="size-3.5" />
        {runningCount > 0 ? `${runningCount} running` : 'Tasks'}
      </Button>

      <Button
        variant="ghost"
        size="icon"
        aria-label="All tasks"
        aria-pressed={onTasksRoute}
        onClick={handleTasksNavClick}
        className={cn(onTasksRoute && 'bg-accent/15 text-foreground')}
      >
        <ListChecks className="size-4" />
      </Button>

      <ThemeToggle />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="User menu">
            <UserRound className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{auth?.username ?? '…'}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void router.navigate({ to: '/preferences' })}>
            Preferences
          </DropdownMenuItem>
          {SUPPORT_URL && (
            <DropdownMenuItem asChild>
              <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
                <Coffee className="size-4" aria-hidden="true" />
                Buy me a coffee
              </a>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            disabled={auth?.mode !== 'session'}
            onSelect={(e) => {
              e.preventDefault();
              void handleLogout();
            }}
          >
            Logout
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
