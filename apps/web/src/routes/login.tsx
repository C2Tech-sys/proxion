import { useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { USE_FIXTURES, api } from '@/api/client';
import { AUTH_ME_QUERY_KEY } from '@/api/hooks';
import { Logo } from '@/components/Logo';
import { APP_NAME } from '@/lib/app';

export const Route = createFileRoute('/login')({
  // The route the visitor actually asked for, carried here by the `_shell` auth gate
  // (`routes/_shell.tsx`) so a successful login can return them to it instead of always `/`.
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === 'string' ? { redirect: search.redirect } : {},
  component: LoginPage,
});

function LoginPage() {
  const { redirect } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.login(username, password);
      // The gate reads `useAuthMe()` (`GET /api/auth/me`); without this it wouldn't notice the
      // new session until that query's own staleTime elapsed, leaving the visitor stuck on
      // /login right after a successful sign-in.
      await queryClient.invalidateQueries({ queryKey: AUTH_ME_QUERY_KEY });
      await navigate({ to: redirect ?? '/' });
    } catch {
      const message = USE_FIXTURES
        ? 'Backend not connected. This is fixture mode; sign-in is disabled.'
        : 'Sign-in failed.';
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-4">
      <form
        onSubmit={onSubmit}
        className="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-border bg-card p-6"
      >
        <div>
          <h1 className="inline-flex items-center gap-2 font-display text-[16px] font-semibold tracking-[0.18em]">
            <Logo className="size-5" />
            <span className="pt-[0.14em]">{APP_NAME.toUpperCase()}</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to continue.</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="username" className="text-xs text-muted-foreground">
            Username
          </label>
          <Input
            id="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="root@pam"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="password" className="text-xs text-muted-foreground">
            Password
          </label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error && (
          <p role="alert" className="text-xs text-status-error">
            {error}
          </p>
        )}

        <Button type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </main>
  );
}
