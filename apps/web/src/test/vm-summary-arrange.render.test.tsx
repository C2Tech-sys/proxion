import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';
import { PREFS_DEFAULTS, type UserPrefs } from '@/api/prefs';

// Several of this page's fixture-client queries (status, config, agent, rrd, cluster resources,
// node tasks, and now prefs) stack their simulated delays -- see vm-summary-last-backup's own
// copy of this constant for why the default 1000ms findBy* timeout isn't enough.
const FIND_TIMEOUT_MS = 5000;

const { patchPrefsMock } = vi.hoisted(() => ({ patchPrefsMock: vi.fn() }));

/**
 * T22: SummaryTab now reads/writes `prefs.summaryLayout` through `usePrefs`/`useUpdatePrefs`
 * (`@/api/prefsHooks`). Rather than mocking those hooks directly (which would also have to stub
 * every other field `useThemePreferenceSync`/the shell reads off `usePrefs`), this mocks
 * `@/api/prefs`'s `getPrefs`/`patchPrefs` the same way `preferences-page.render.test.tsx` does:
 * a test-controlled in-memory document, with `patchPrefsMock` both recording calls *and* actually
 * merging them in, so a saved order (or a fresh arrange-mode change) is immediately visible to
 * the next read.
 */
let currentPrefs: UserPrefs = { ...PREFS_DEFAULTS };

vi.mock('@/api/prefs', async () => {
  const actual = await vi.importActual<typeof import('@/api/prefs')>('@/api/prefs');
  return {
    ...actual,
    getPrefs: () => Promise.resolve({ ...currentPrefs, readOnly: false }),
    patchPrefs: patchPrefsMock,
  };
});

function renderSummary(path = '/vm/pve1/qemu/104') {
  const queryClient = createQueryClient();
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

/** The Summary tab's own panel headers -- Panel is the only component in the tree using `<h3>`. */
async function panelTitles() {
  const headings = await screen.findAllByRole('heading', { level: 3 }, { timeout: FIND_TIMEOUT_MS });
  return headings.map((h) => h.textContent);
}

/**
 * jsdom has no `DragEvent` constructor (https://github.com/jsdom/jsdom/issues/2913), so
 * `@testing-library`'s `fireEvent.dragOver`/`.drop` silently fall back to a plain `Event` built
 * from *only* `bubbles`/`cancelable` -- `clientY` and `dataTransfer` never make it onto the event
 * object (verified: `event.clientY` comes back `undefined`). Building the event by hand and
 * assigning the extra properties directly is what actually gets them onto the object the
 * component's handler reads, while still going through `fireEvent` (not a raw
 * `dispatchEvent`) so the resulting state update is flushed inside its `act()` wrapper.
 */
function dragEvent(type: string, props: Record<string, unknown>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, props);
  return event;
}

describe('VM Summary tab: arrange (T22)', () => {
  beforeEach(() => {
    currentPrefs = { ...PREFS_DEFAULTS };
    patchPrefsMock.mockReset();
    patchPrefsMock.mockImplementation((patch: Partial<UserPrefs>) => {
      currentPrefs = { ...currentPrefs, ...patch };
      return Promise.resolve({ ...currentPrefs, readOnly: false });
    });
  });

  it('renders panels in the saved order for this guest type', async () => {
    currentPrefs = {
      ...PREFS_DEFAULTS,
      summaryLayout: {
        qemu: ['notes', 'console', 'guest', 'hardware', 'resources', 'related', 'snapshots', 'lastBackup'],
      },
    };
    renderSummary();

    const titles = await panelTitles();
    expect(titles[0]).toBe('Notes');
    expect(titles[1]).toBe('Console');
    expect(titles[2]).toBe('Guest');
  });

  it('falls back to the default order for an unknown id and appends a missing one', async () => {
    currentPrefs = {
      ...PREFS_DEFAULTS,
      // 'madeUpPanel' doesn't exist; every real id but 'lastBackup' is missing entirely.
      summaryLayout: { qemu: ['madeUpPanel', 'lastBackup'] },
    };
    renderSummary();

    const titles = await panelTitles();
    expect(titles[0]).toBe('Last backup');
    expect(titles[1]).toBe('Console');
    expect(titles).toHaveLength(8);
  });

  it('arrange mode reveals drag handles and move buttons; outside it there is nothing extra', async () => {
    renderSummary();
    await panelTitles();

    expect(screen.queryAllByTestId('drag-handle')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Move Console down' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Arrange' }));

    expect(screen.getAllByTestId('drag-handle').length).toBe(8);
    expect(screen.getByRole('button', { name: 'Move Console down' })).toBeInTheDocument();
    // First visible panel (Console) can't move up.
    expect(screen.getByRole('button', { name: 'Move Console up' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryAllByTestId('drag-handle')).toHaveLength(0);
  });

  it('"Move down" on the first panel patches summaryLayout with the panel moved one position down', async () => {
    renderSummary();
    await panelTitles();

    fireEvent.click(screen.getByRole('button', { name: 'Arrange' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Console down' }));

    await waitFor(() => expect(patchPrefsMock).toHaveBeenCalled());
    const patchArg = patchPrefsMock.mock.calls.at(-1)?.[0] as Partial<UserPrefs>;
    const order = patchArg.summaryLayout?.qemu;
    expect(order?.[0]).toBe('guest');
    expect(order?.[1]).toBe('console');
    expect(order).toHaveLength(8);
  });

  it('dropping a panel before another reorders them', async () => {
    renderSummary();
    await panelTitles();
    fireEvent.click(screen.getByRole('button', { name: 'Arrange' }));

    const sourceHeader = screen.getByRole('heading', { level: 3, name: 'Last backup' });
    const sourceWrapper = sourceHeader.closest('[data-arrange-mode]') as HTMLElement;
    const targetHeader = screen.getByRole('heading', { level: 3, name: 'Guest' });
    const targetWrapper = targetHeader.closest('[data-arrange-mode]') as HTMLElement;

    vi.spyOn(targetWrapper, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 200,
      height: 100,
      left: 0,
      right: 100,
      width: 100,
      x: 0,
      y: 100,
      toJSON() {
        return {};
      },
    } as DOMRect);

    const dataTransfer = {
      setData: vi.fn(),
      getData: vi.fn(() => 'lastBackup'),
      effectAllowed: '',
    };
    fireEvent(sourceWrapper, dragEvent('dragstart', { dataTransfer }));
    // clientY above the target's midpoint (150) -> "before".
    fireEvent(targetWrapper, dragEvent('dragover', { dataTransfer, clientY: 90 }));
    fireEvent(targetWrapper, dragEvent('drop', { dataTransfer, clientY: 90 }));

    await waitFor(() => expect(patchPrefsMock).toHaveBeenCalled());
    const patchArg = patchPrefsMock.mock.calls.at(-1)?.[0] as Partial<UserPrefs>;
    const order = patchArg.summaryLayout?.qemu ?? [];
    expect(order.indexOf('lastBackup')).toBeLessThan(order.indexOf('guest'));
    expect(order).toHaveLength(8);
  });
});
