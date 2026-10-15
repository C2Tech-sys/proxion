import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';
import { CLUSTER_RESOURCES_QUERY_KEY } from '@/api/liveState';
import { reorderFixtureClusterResources, resetFixtureClusterResources } from '@/api/fixtures';
import { PREFS_DEFAULTS, type PrefsPatch, type PrefsResponse, type UserPrefs } from '@/api/prefs';
import { PREFS_QUERY_KEY } from '@/api/prefsHooks';
import type { ClusterResource } from '@/api/types';

/** Generous on purpose -- route-level render test against the fixture client (see
 *  guests-column-visibility.render.test.tsx for the same reasoning). */
const FIND_TIMEOUT_MS = 10_000;

const { patchPrefsMock } = vi.hoisted(() => ({ patchPrefsMock: vi.fn() }));

let prefsState: UserPrefs = { ...PREFS_DEFAULTS };
let readOnlyPrefs = false;

vi.mock('@/api/prefs', async () => {
  const actual = await vi.importActual<typeof import('@/api/prefs')>('@/api/prefs');
  return {
    ...actual,
    getPrefs: () => Promise.resolve({ ...prefsState, readOnly: readOnlyPrefs }),
    patchPrefs: patchPrefsMock,
  };
});

// pve1: local, local-zfs, tank, tank-backups; pve2: local (checked-in fixture rows). `pve1/local`
// and `pve2/local` have exactly the same usage fraction (66571993088 / 214748364800 is twice
// 33285996544 / 107374182400), which makes them a real tie on the usage key.
const NAME_ASC = ['local (pve1)', 'local (pve2)', 'local-zfs (pve1)', 'tank (pve1)', 'tank-backups (pve1)'];
const USAGE_ASC = ['local (pve1)', 'local (pve2)', 'local-zfs (pve1)', 'tank (pve1)', 'tank-backups (pve1)'];
const USAGE_DESC = ['tank-backups (pve1)', 'tank (pve1)', 'local-zfs (pve1)', 'local (pve1)', 'local (pve2)'];
const AVAIL_ASC = ['local (pve2)', 'local (pve1)', 'tank-backups (pve1)', 'local-zfs (pve1)', 'tank (pve1)'];

function renderDashboard() {
  const queryClient = createQueryClient();
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { queryClient, ...utils };
}

async function sortSelect(): Promise<HTMLSelectElement> {
  return (await screen.findByRole('combobox', { name: 'Sort storages by' }, { timeout: FIND_TIMEOUT_MS })) as HTMLSelectElement;
}

/** The storage list's rows, top to bottom, as "name (node)". */
async function renderedStorages(): Promise<string[]> {
  const panel = (await sortSelect()).closest('section') as HTMLElement;
  return within(panel)
    .getAllByRole('link')
    .map((a) => a.textContent ?? '');
}

describe('Dashboard Storage panel (T74)', () => {
  beforeEach(() => {
    resetFixtureClusterResources();
    prefsState = { ...PREFS_DEFAULTS };
    readOnlyPrefs = false;
    patchPrefsMock.mockReset();
    patchPrefsMock.mockImplementation((patch: PrefsPatch) => {
      prefsState = { ...prefsState, ...patch };
      return Promise.resolve({ ...prefsState, readOnly: false });
    });
  });

  it('lists storages by name ascending, identically for two different input orders', async () => {
    reorderFixtureClusterResources('reverse');
    const first = renderDashboard();
    expect(await renderedStorages()).toStrictEqual(NAME_ASC);
    first.unmount();

    resetFixtureClusterResources();
    reorderFixtureClusterResources('shuffle(3)');
    renderDashboard();
    expect(await renderedStorages()).toStrictEqual(NAME_ASC);
  });

  it('does not move when a later poll returns the rows in a different order', async () => {
    const { queryClient } = renderDashboard();
    expect(await renderedStorages()).toStrictEqual(NAME_ASC);

    reorderFixtureClusterResources('reverse');
    await queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
    await waitFor(() => {
      const cached = queryClient.getQueryData<ClusterResource[]>(CLUSTER_RESOURCES_QUERY_KEY) ?? [];
      expect(cached[0]?.id).toBe('storage/pve2/local'); // the refetched array really is reordered
    });

    expect(await renderedStorages()).toStrictEqual(NAME_ASC);
    expect(patchPrefsMock).not.toHaveBeenCalled();
  });

  it('shows Name / ascending by default, with the six labelled keys, and writes nothing on load', async () => {
    renderDashboard();
    const select = await sortSelect();
    expect(select).toHaveValue('name');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toStrictEqual([
      'Name',
      'Node',
      'Type',
      'Used',
      'Free',
      'Usage %',
    ]);
    expect(screen.getByRole('button', { name: 'Sort ascending' })).toBeInTheDocument();
    expect(patchPrefsMock).not.toHaveBeenCalled();
  });

  it('applies a saved preference on first render', async () => {
    prefsState = { ...PREFS_DEFAULTS, storageSort: { key: 'usage', dir: 'desc' } };
    renderDashboard();
    await waitFor(async () => expect(await renderedStorages()).toStrictEqual(USAGE_DESC));
    expect(await sortSelect()).toHaveValue('usage');
    expect(screen.getByRole('button', { name: 'Sort descending' })).toBeInTheDocument();
    expect(patchPrefsMock).not.toHaveBeenCalled();
  });

  it('choosing a sort key saves exactly { storageSort: { key, dir } } and re-sorts at once', async () => {
    renderDashboard();
    const select = await sortSelect();

    fireEvent.change(select, { target: { value: 'usage' } });

    await waitFor(() => expect(patchPrefsMock).toHaveBeenCalledTimes(1));
    expect(patchPrefsMock.mock.calls[0]?.[0]).toStrictEqual({ storageSort: { key: 'usage', dir: 'asc' } });
    await waitFor(async () => expect(await renderedStorages()).toStrictEqual(USAGE_ASC));
    expect(select).toHaveValue('usage');

    fireEvent.change(select, { target: { value: 'avail' } });
    await waitFor(() => expect(patchPrefsMock).toHaveBeenCalledTimes(2));
    expect(patchPrefsMock.mock.calls[1]?.[0]).toStrictEqual({ storageSort: { key: 'avail', dir: 'asc' } });
    await waitFor(async () => expect(await renderedStorages()).toStrictEqual(AVAIL_ASC));
  });

  it('the direction toggle saves the flipped direction and reverses the order', async () => {
    renderDashboard();
    const select = await sortSelect();
    fireEvent.change(select, { target: { value: 'usage' } });
    await waitFor(() => expect(patchPrefsMock).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole('button', { name: 'Sort ascending' }));

    await waitFor(() => expect(patchPrefsMock).toHaveBeenCalledTimes(2));
    expect(patchPrefsMock.mock.calls[1]?.[0]).toStrictEqual({ storageSort: { key: 'usage', dir: 'desc' } });
    await waitFor(async () => expect(await renderedStorages()).toStrictEqual(USAGE_DESC));
    expect(screen.getByRole('button', { name: 'Sort descending' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sort descending' }));
    await waitFor(() => expect(patchPrefsMock).toHaveBeenCalledTimes(3));
    expect(patchPrefsMock.mock.calls[2]?.[0]).toStrictEqual({ storageSort: { key: 'usage', dir: 'asc' } });
  });

  it('keeps the saved direction when only the key changes', async () => {
    prefsState = { ...PREFS_DEFAULTS, storageSort: { key: 'name', dir: 'desc' } };
    renderDashboard();
    await waitFor(async () => expect(await sortSelect()).toHaveValue('name'));
    await screen.findByRole('button', { name: 'Sort descending' });

    fireEvent.change(await sortSelect(), { target: { value: 'avail' } });

    await waitFor(() => expect(patchPrefsMock).toHaveBeenCalledTimes(1));
    expect(patchPrefsMock.mock.calls[0]?.[0]).toStrictEqual({ storageSort: { key: 'avail', dir: 'desc' } });
    await waitFor(async () => expect(await renderedStorages()).toStrictEqual([...AVAIL_ASC].reverse()));
  });

  it('read-only prefs (token mode): still re-sorts locally but never calls the update', async () => {
    readOnlyPrefs = true;
    const { queryClient } = renderDashboard();
    const select = await sortSelect();
    // Interact only once the prefs response (readOnly: true) is in the cache.
    await waitFor(() =>
      expect(queryClient.getQueryData<PrefsResponse>(PREFS_QUERY_KEY)?.readOnly).toBe(true),
    );
    expect(await renderedStorages()).toStrictEqual(NAME_ASC);

    fireEvent.change(select, { target: { value: 'usage' } });
    await waitFor(async () => expect(await renderedStorages()).toStrictEqual(USAGE_ASC));
    fireEvent.click(screen.getByRole('button', { name: 'Sort ascending' }));
    await waitFor(async () => expect(await renderedStorages()).toStrictEqual(USAGE_DESC));

    expect(patchPrefsMock).not.toHaveBeenCalled();
  });
});
