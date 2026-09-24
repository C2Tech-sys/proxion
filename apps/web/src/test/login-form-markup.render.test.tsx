import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';

const FIND_TIMEOUT_MS = 10_000;

/**
 * Password managers (Keeper, 1Password, Bitwarden, the browsers' own) recognise a login form
 * by a text + password input pair carrying `name`/`autocomplete` attributes inside a real
 * POST form. Without `name` several of them never offer to fill. Pin that markup.
 */
describe('login form markup for password managers', () => {
  it('has a named username/password pair with autocomplete hints inside a POST form', async () => {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/login'] }) });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    const username = await screen.findByLabelText('Username', {}, { timeout: FIND_TIMEOUT_MS });
    const password = screen.getByLabelText('Password');
    const form = username.closest('form');

    expect(username).toHaveAttribute('name', 'username');
    expect(username).toHaveAttribute('type', 'text');
    expect(username).toHaveAttribute('autocomplete', 'username');
    expect(password).toHaveAttribute('name', 'password');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
    expect(form).not.toBeNull();
    expect(form).toHaveAttribute('method', 'post');
    expect(form?.querySelector('button[type="submit"]')).not.toBeNull();
  });
});
