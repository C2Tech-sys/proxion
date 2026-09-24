import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { getPrefs, patchPrefs, PREFS_DEFAULTS, type PrefsPatch, type PrefsResponse } from '@/api/prefs';
import { useAuthMe } from '@/api/hooks';
import { errorMessage } from '@/api/errors';
import { useUiStore } from '@/store/ui';

export const PREFS_QUERY_KEY = ['prefs'] as const;

/**
 * The signed-in user's preferences, merged over defaults by the server. Disabled until
 * `/api/auth/me` has actually resolved to an identity -- there's nothing to fetch prefs *for*
 * before then, and firing the request early would just 401 (or, in fixture mode, run pointlessly
 * before the auth gate even lets the shell render).
 */
export function usePrefs() {
  const { data: auth } = useAuthMe();
  return useQuery({
    queryKey: PREFS_QUERY_KEY,
    queryFn: () => getPrefs(),
    enabled: Boolean(auth),
    staleTime: 60_000,
  });
}

interface MutationContext {
  previous: PrefsResponse | undefined;
  /** This mutation's position in the sequence of preference writes (see `latestPrefsWrite`). */
  seq: number;
}

/**
 * Monotonic counter over every preference write started by any `useUpdatePrefs()` instance in
 * this app. Two quick saves (a double-click, two "Move up"s) each apply an optimistic update in
 * order, but their responses can come back out of order; only the NEWEST write may put its
 * response (or its rollback) into the cache, otherwise a slow first response silently undoes
 * the second's change.
 */
let latestPrefsWrite = 0;

/**
 * `PATCH /api/prefs` with an optimistic update: the change is applied to the cache (and so to
 * every `usePrefs()` consumer, including the theme sync below) immediately, before the request
 * even resolves, and rolled back with a toast if it fails -- a token-mode `403` or a validation
 * `400` both look the same to the caller here (an error), which is fine: the Preferences page's
 * controls are simply disabled in token mode (see `PreferencesPage.tsx`), so a real user should
 * never hit the 403 path at all.
 */
export function useUpdatePrefs() {
  const queryClient = useQueryClient();
  return useMutation<PrefsResponse, unknown, PrefsPatch, MutationContext>({
    mutationFn: (patch) => patchPrefs(patch),
    onMutate: async (patch) => {
      const seq = ++latestPrefsWrite;
      await queryClient.cancelQueries({ queryKey: PREFS_QUERY_KEY });
      const previous = queryClient.getQueryData<PrefsResponse>(PREFS_QUERY_KEY);
      const base: PrefsResponse = previous ?? { ...PREFS_DEFAULTS, readOnly: false };
      queryClient.setQueryData<PrefsResponse>(PREFS_QUERY_KEY, { ...base, ...patch });
      return { previous, seq };
    },
    onError: (error, _patch, context) => {
      // Only the newest write rolls back: an older write failing after a newer optimistic update
      // landed must not wipe the newer state. Either way the query is refetched below, so the
      // cache converges on what the server actually holds.
      if (context && context.seq === latestPrefsWrite) {
        queryClient.setQueryData(PREFS_QUERY_KEY, context.previous);
      }
      toast.error(`Could not save preferences: ${errorMessage(error)}`);
    },
    onSuccess: (data, _patch, context) => {
      // A response from an older write must not overwrite a newer optimistic update.
      if (context.seq === latestPrefsWrite) queryClient.setQueryData(PREFS_QUERY_KEY, data);
    },
    onSettled: (_data, _error, _patch, context) => {
      // Once the newest write settles, reconcile with the server -- cheap, and it repairs any
      // interleaving the guards above could not reason about (e.g. an older write that failed).
      if (context?.seq === latestPrefsWrite) {
        void queryClient.invalidateQueries({ queryKey: PREFS_QUERY_KEY });
      }
    },
  });
}

function systemPrefersLight(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches;
  } catch {
    return false;
  }
}

/**
 * Applies `prefs.theme` to the shell (`system` resolved live via `prefers-color-scheme`, kept in
 * sync as the OS setting changes) once it's known, mirroring the resolved value to
 * `localStorage` via `useUiStore.setTheme` -- the same store `store/ui.ts` already used for the
 * pre-auth fast-paint guess, so there is exactly one place that ever touches the DOM's theme
 * class. Call once, high in the authenticated shell (see `TopBar.tsx`): before `usePrefs()`
 * resolves this is a no-op, leaving that fast-paint guess on screen untouched, so a first visit
 * never flickers between two guesses.
 */
export function useThemePreferenceSync(): void {
  const { data: prefs } = usePrefs();
  const setTheme = useUiStore((s) => s.setTheme);

  useEffect(() => {
    if (!prefs) return;

    function resolve(): 'light' | 'dark' {
      if (prefs!.theme !== 'system') return prefs!.theme;
      return systemPrefersLight() ? 'light' : 'dark';
    }

    // Skip the store update entirely when it would be a no-op (the common case: this browser's
    // fast-path guess already matches) rather than re-applying the same value on every render.
    if (useUiStore.getState().theme !== resolve()) setTheme(resolve());

    if (prefs.theme !== 'system' || typeof window.matchMedia !== 'function') return undefined;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setTheme(mediaQuery.matches ? 'light' : 'dark');
    mediaQuery.addEventListener('change', onChange);
    return () => mediaQuery.removeEventListener('change', onChange);
  }, [prefs, setTheme]);
}
