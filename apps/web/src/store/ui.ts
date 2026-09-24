import { create } from 'zustand';

export type Theme = 'light' | 'dark';

const THEME_KEY = 'proxion.theme';

// 340px: InventoryTree's guest rows show two real color-coded tag chips (+N) at a >=300px rail
// via a container query (see InventoryTree.tsx's GUEST_ROW_GRID) and fall back to a single grey
// "N tags" summary chip below that. 340 clears the breakpoint with margin and keeps every
// fixture guest name un-truncated with the current typography. Exported so the Preferences
// page's Layout panel and its "Reset to default" can reference the same value `_shell.tsx`
// falls back to when there's no stored `railWidth` preference (or before prefs have loaded).
export const DEFAULT_SIDEBAR_WIDTH = 340;

function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function applyThemeClass(theme: Theme) {
  try {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  } catch {
    // no-op outside a DOM environment (e.g. some test setups)
  }
}

export interface UiState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  sidebarCollapsed: boolean;
  toggleSidebarCollapsed: () => void;
  tasksDrawerOpen: boolean;
  setTasksDrawerOpen: (open: boolean) => void;
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;
}

const initialTheme = readStoredTheme() ?? systemTheme();
applyThemeClass(initialTheme);

export const useUiStore = create<UiState>((set, get) => ({
  theme: initialTheme,
  setTheme: (theme) => {
    applyThemeClass(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // ignore persistence failures (private browsing, etc.)
    }
    set({ theme });
  },
  toggleTheme: () => {
    const next: Theme = get().theme === 'dark' ? 'light' : 'dark';
    get().setTheme(next);
  },
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  sidebarCollapsed: false,
  toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  tasksDrawerOpen: false,
  setTasksDrawerOpen: (open) => set({ tasksDrawerOpen: open }),
  commandPaletteOpen: false,
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
}));
