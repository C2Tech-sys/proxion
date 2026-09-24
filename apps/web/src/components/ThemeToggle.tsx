import { Moon, Sun } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useUiStore } from '@/store/ui';
import { useAuthMe } from '@/api/hooks';
import { useUpdatePrefs } from '@/api/prefsHooks';

/**
 * Toggles between light and dark theme -- always pins an explicit choice (never re-enters
 * `system`; that's the Preferences page's job). For a session, writes through
 * `useUpdatePrefs` (optimistic -- the class flips immediately, same as before, while the write
 * happens in the background) so the choice follows the user to their next browser. In token mode
 * or fixtures (no per-person prefs to write: a shared token isn't a person, and the demo has no
 * backend), falls back to the previous local-only behavior.
 */
export function ThemeToggle() {
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const { data: auth } = useAuthMe();
  const updatePrefs = useUpdatePrefs();

  function handleClick() {
    if (auth?.mode === 'session') {
      updatePrefs.mutate({ theme: theme === 'dark' ? 'light' : 'dark' });
      return;
    }
    toggleTheme();
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={handleClick}
        >
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</TooltipContent>
    </Tooltip>
  );
}
