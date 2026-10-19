import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';
import { CLUSTER_RESOURCES_QUERY_KEY } from '@/api/liveState';
import {
  reorderFixtureClusterResources,
  resetFixtureClusterResources,
  resetFixtureStorageContent,
  setFixtureStorageContent,
} from '@/api/fixtures';
import { PREFS_DEFAULTS, type PrefsPatch, type PrefsResponse, type UserPrefs } from '@/api/prefs';
import { PREFS_QUERY_KEY } from '@/api/prefsHooks';
import type { ClusterResource } from '@/api/types';

/** Generous on purpose -- route-level render test against the fixture client (see
 *  node-tasks-tab.render.test.tsx for the same reasoning). */
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

// pve1's storages (checked-in fixture rows): local (dir, 31% used, 148 GB free), local-zfs
// (zfspool, 46%, 526 GB free), tank (zfspool, 60%, 1.5 TB free), tank-backups (dir, 88%, 515 GB free).
const NAME_ASC = ['local', 'local-zfs', 'tank', 'tank-backups'];
const TYPE_ASC = ['local', 'tank-backups', 'local-zfs', 'tank']; // dir, dir, zfspool, zfspool (ties by id)
const TYPE_DESC = ['local-zfs', 'tank', 'local', 'tank-backups'];
const AVAIL_ASC = ['local', 'tank-backups', 'local-zfs', 'tank'];

function renderNodeStorage() {
  const queryClient = createQueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/node/pve1?tab=storage'] }),
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { queryClient, ...utils };
}

/** The storage table's column header. Always the FIRST match in document order: an expanded row's
 *  content browser is a second table with its own "Name" header further down. */
function colHead(name: string): HTMLElement {
  const head = screen.getAllByRole('columnheader', { name })[0];
  if (!head) throw new Error(`no ${name} column header`);
  return head;
}

async function header(name: string): Promise<HTMLElement> {
  await screen.findAllByRole('columnheader', { name }, { timeout: FIND_TIMEOUT_MS });
  return colHead(name);
}

/** The storage table's own body rows (not the nested content browser's), top to bottom. */
async function bodyRows(): Promise<HTMLTableRowElement[]> {
  const nameHead = await header('Name');
  const table = nameHead.closest('table') as HTMLTableElement;
  return Array.from(table.tBodies[0]?.rows ?? []);
}

/** The storage names shown, top to bottom (the expanded content row has no name link). */
async function storageNames(): Promise<string[]> {
  return (await bodyRows())
    .filter((row) => !row.querySelector('td[colspan]'))
    .map((row) => row.querySelector('a')?.textContent ?? '');
}

describe('Node Storage tab: stationary + sortable (T74)', () => {
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
    const first = renderNodeStorage();
    expect(await storageNames()).toStrictEqual(NAME_ASC);
    expect(await header('Name')).toHaveAttribute('aria-sort', 'ascending');
    first.unmount();

    resetFixtureClusterResources();
    reorderFixtureClusterResources('shuffle(5)');
    renderNodeStorage();
    expect(await storageNames()).toStrictEqual(NAME_ASC);
  });

  it('does not move when a later poll returns the rows in a different order', async () => {
    const { queryClient } = renderNodeStorage();
    expect(await storageNames()).toStrictEqual(NAME_ASC);

    reorderFixtureClusterResources('reverse');
    await queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
    await waitFor(() => {
      const cached = queryClient.getQueryData<ClusterResource[]>(CLUSTER_RESOURCES_QUERY_KEY) ?? [];
      expect(cached[0]?.id).toBe('storage/pve2/local'); // the refetched array really is reordered
    });

    expect(await storageNames()).toStrictEqual(NAME_ASC);
    expect(patchPrefsMock).not.toHaveBeenCalled();
  });

  it('a header click sorts ascending, sets aria-sort and saves the exact prefs patch', async () => {
    renderNodeStorage();
    fireEvent.click(within(await header('Type')).getByRole('button'));

    await waitFor(() => expect(patchPrefsMock).toHaveBeenCalledTimes(1));
    expect(patchPrefsMock.mock.calls[0]?.[0]).toStrictEqual({ storageSort: { key: 'type', dir: 'asc' } });
    await waitFor(() => expect(colHead('Type')).toHaveAttribute('aria-sort', 'ascending'));
    expect(colHead('Name')).not.toHaveAttribute('aria-sort');
    expect(await storageNames()).toStrictEqual(TYPE_ASC);
  });

  it('a second click on the active header flips to descending', async () => {
    renderNodeStorage();
    fireEvent.click(within(await header('Type')).getByRole('button'));
    await waitFor(() => expect(colHead('Type')).toHaveAttribute('aria-sort', 'ascending'));

    fireEvent.click(within(colHead('Type')).getByRole('button'));

    await waitFor(() => expect(patchPrefsMock).toHaveBeenCalledTimes(2));
    expect(patchPrefsMock.mock.calls[1]?.[0]).toStrictEqual({ storageSort: { key: 'type', dir: 'desc' } });
    await waitFor(() => expect(colHead('Type')).toHaveAttribute('aria-sort', 'descending'));
    expect(await storageNames()).toStrictEqual(TYPE_DESC);
  });

  it('Name (active by default) flips to descending; Used sorts by usage; Avail by free space', async () => {
    renderNodeStorage();
    fireEvent.click(within(await header('Name')).getByRole('button'));
    await waitFor(() => expect(patchPrefsMock).toHaveBeenCalledTimes(1));
    expect(patchPrefsMock.mock.calls[0]?.[0]).toStrictEqual({ storageSort: { key: 'name', dir: 'desc' } });
    await waitFor(async () => expect(await storageNames()).toStrictEqual([...NAME_ASC].reverse()));

    fireEvent.click(within(colHead('Used')).getByRole('button'));
    await waitFor(() => expect(patchPrefsMock).toHaveBeenCalledTimes(2));
    expect(patchPrefsMock.mock.calls[1]?.[0]).toStrictEqual({ storageSort: { key: 'usage', dir: 'asc' } });
    await waitFor(() => expect(colHead('Used')).toHaveAttribute('aria-sort', 'ascending'));
    expect(await storageNames()).toStrictEqual(NAME_ASC); // 31% < 46% < 60% < 88%

    fireEvent.click(within(colHead('Avail')).getByRole('button'));
    await waitFor(() => expect(patchPrefsMock).toHaveBeenCalledTimes(3));
    expect(patchPrefsMock.mock.calls[2]?.[0]).toStrictEqual({ storageSort: { key: 'avail', dir: 'asc' } });
    await waitFor(async () => expect(await storageNames()).toStrictEqual(AVAIL_ASC));
  });

  it('the expanded content row stays attached to its storage when the order changes', async () => {
    renderNodeStorage();
    expect(await storageNames()).toStrictEqual(NAME_ASC);

    fireEvent.click(screen.getByRole('link', { name: 'local-zfs' }).closest('tr') as HTMLElement);
    async function expectContentRowAfter(name: string) {
      const rows = await bodyRows();
      const index = rows.findIndex((row) => row.querySelector('a')?.textContent === name);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(rows[index + 1]?.querySelector('td[colspan]')).not.toBeNull();
      expect(rows.filter((row) => row.querySelector('td[colspan]'))).toHaveLength(1);
    }
    await waitFor(() => expectContentRowAfter('local-zfs'));

    fireEvent.click(within(colHead('Name')).getByRole('button'));
    await waitFor(async () => expect(await storageNames()).toStrictEqual([...NAME_ASC].reverse()));
    await expectContentRowAfter('local-zfs');

    fireEvent.click(within(colHead('Avail')).getByRole('button'));
    await waitFor(async () => expect(await storageNames()).toStrictEqual(AVAIL_ASC));
    await expectContentRowAfter('local-zfs');
  });

  it('applies a saved preference on first render, with aria-sort on its column only', async () => {
    prefsState = { ...PREFS_DEFAULTS, storageSort: { key: 'avail', dir: 'desc' } };
    renderNodeStorage();

    await waitFor(async () => expect(await storageNames()).toStrictEqual([...AVAIL_ASC].reverse()));
    expect(colHead('Avail')).toHaveAttribute('aria-sort', 'descending');
    expect(colHead('Name')).not.toHaveAttribute('aria-sort');
    expect(patchPrefsMock).not.toHaveBeenCalled();
  });

  it("the dashboard's saved 'used' key sorts the list and lights the Used column", async () => {
    prefsState = { ...PREFS_DEFAULTS, storageSort: { key: 'used', dir: 'desc' } };
    renderNodeStorage();

    // Used bytes, descending: tank-backups (3.4 TB), tank (2.1 TB), local-zfs (410 GB), local (62 GB).
    await waitFor(async () =>
      expect(await storageNames()).toStrictEqual(['tank-backups', 'tank', 'local-zfs', 'local']),
    );
    expect(colHead('Used')).toHaveAttribute('aria-sort', 'descending');
  });

  it('read-only prefs (token mode): still re-sorts locally but never calls the update', async () => {
    readOnlyPrefs = true;
    const { queryClient } = renderNodeStorage();
    await header('Type');
    await waitFor(() =>
      expect(queryClient.getQueryData<PrefsResponse>(PREFS_QUERY_KEY)?.readOnly).toBe(true),
    );

    fireEvent.click(within(await header('Type')).getByRole('button'));

    await waitFor(async () => expect(await storageNames()).toStrictEqual(TYPE_ASC));
    expect(colHead('Type')).toHaveAttribute('aria-sort', 'ascending');
    expect(patchPrefsMock).not.toHaveBeenCalled();
  });
});

describe('Node Storage tab: content-type chips (T76)', () => {
  beforeEach(() => {
    resetFixtureClusterResources();
    prefsState = { ...PREFS_DEFAULTS };
    readOnlyPrefs = false;
  });

  afterEach(() => {
    resetFixtureStorageContent();
  });

  /** The Content column's chips for one storage row, in document order. */
  async function contentChips(storage: string): Promise<string[]> {
    const row = (await bodyRows()).find((r) => r.querySelector('a')?.textContent === storage);
    if (!row) throw new Error(`no ${storage} row`);
    return Array.from(row.cells[3]?.querySelectorAll('.tag-chip') ?? []).map((c) => c.textContent ?? '');
  }

  it('shows the content types in PVE order whatever order the content string arrives in', async () => {
    setFixtureStorageContent('pve1', 'local', 'backup,snippets,import,iso,vztmpl');
    renderNodeStorage();
    expect(await contentChips('local')).toStrictEqual(['vztmpl', 'iso', 'backup', 'snippets', 'import']);
    cleanup();

    setFixtureStorageContent('pve1', 'local', 'import,vztmpl,iso,snippets,backup');
    renderNodeStorage();
    expect(await contentChips('local')).toStrictEqual(['vztmpl', 'iso', 'backup', 'snippets', 'import']);
  });
});
