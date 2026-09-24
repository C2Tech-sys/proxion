import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import type { AuthIdentity } from '@/api/client-types';

/**
 * These tests force the real (non-fixture) client so the `_shell` auth gate's actual
 * `useAuthMe()`-driven behaviour runs, rather than fixture mode's always-authenticated demo
 * identity (that path is already covered by `shell.render.test.tsx` + the token-mode assertion
 * below). `getAuthMe`/`login` are mocked directly; `/api/state` is stubbed on `fetch` so any
 * mounted child that polls live state (TopBar, the dashboard) settles instead of hanging.
 */
const getAuthMeMock = vi.fn<() => Promise<AuthIdentity | null>>();
const loginMock = vi.fn<() => Promise<never>>();

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    USE_FIXTURES: false,
    api: {
      ...actual.httpClient,
      getAuthMe: () => getAuthMeMock(),
      login: (...args: unknown[]) => loginMock(...(args as [])),
    },
  };
});

function renderApp(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

describe('auth gate (real client)', () => {
  beforeEach(() => {
    // jsdom doesn't implement the Pointer Events API Radix's DropdownMenu (the user menu)
    // relies on to open -- minimal no-op polyfills so a real click on its trigger works here.
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

    getAuthMeMock.mockReset();
    loginMock.mockReset();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        if (String(input) === '/api/state') {
          return Promise.resolve(new Response(null, { status: 503 }));
        }
        return Promise.reject(new Error(`unexpected fetch to ${String(input)} in this test`));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redirects an unauthenticated visit to a shell route to /login, carrying the requested path', async () => {
    getAuthMeMock.mockResolvedValue(null);
    const { router } = renderApp('/tasks');

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toEqual({ redirect: '/tasks' });
    expect(await screen.findByText('Sign in to continue.')).toBeInTheDocument();
  });

  it('does not redirect when /api/auth/me reports the token identity (mode: "token")', async () => {
    getAuthMeMock.mockResolvedValue({
      username: 'proxion@pve!dev',
      realm: 'token',
      capabilities: {},
      mode: 'token',
    });
    const { router } = renderApp('/tasks');

    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'));
    // The dropdown's contents (username label, Logout item) are a Radix portal that only
    // mounts once opened -- Radix's trigger opens on `pointerdown`, not `click`.
    const userMenuButton = await screen.findByRole('button', { name: 'User menu' });
    fireEvent.pointerDown(userMenuButton, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.pointerUp(userMenuButton, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(userMenuButton);
    expect(await screen.findByText('proxion@pve!dev')).toBeInTheDocument();
    // Token mode: Logout is present but disabled, never a live session to end.
    expect(await screen.findByText('Logout')).toHaveAttribute('data-disabled');
  });

  it('a successful login returns the visitor to the route they originally requested', async () => {
    getAuthMeMock.mockResolvedValueOnce(null); // initial gate check on /tasks -> redirected
    const { router } = renderApp('/tasks');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));

    loginMock.mockResolvedValue(undefined as never);
    getAuthMeMock.mockResolvedValue({
      username: 'root@pam',
      realm: 'pam',
      capabilities: {},
      mode: 'session',
    });

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'root@pam' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });

    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'));
    expect(loginMock).toHaveBeenCalledWith('root@pam', 'hunter2');
  });
});
