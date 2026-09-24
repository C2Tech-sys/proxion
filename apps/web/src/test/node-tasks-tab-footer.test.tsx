import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { PveTask } from '@/api/types';

// The fixture data never reaches exactly 200 rows for one node (nor should it, to stay
// realistic) -- the footer's "N === limit" trigger is exercised directly against the component
// with a mocked `useNodeTasks`, isolated from fixture volume the same way
// dashboard-consoles-panel.render.test.tsx isolates `ConsolesPanel` from `ConsoleThumbnail`.
// This mock is file-scoped (hoisted), which is exactly why it lives in its own test file rather
// than alongside node-tasks-tab.render.test.tsx's real-fixture-client integration tests.
vi.mock('@/api/hooks', () => ({
  useNodeTasks: vi.fn(),
  useTaskLog: vi.fn(() => ({ data: undefined, isLoading: false })),
}));

import { useNodeTasks } from '@/api/hooks';
import { TasksTab } from '@/pages/node/tabs/TasksTab';

function makeTask(i: number): PveTask {
  return {
    upid: `UPID:pve1:0000000${i}:00000000:00000000:qmstart:10${i}:root@pam:`,
    node: 'pve1',
    pid: i,
    pstart: i,
    starttime: 1_700_000_000 - i,
    endtime: 1_700_000_010 - i,
    type: 'qmstart',
    id: String(100 + i),
    user: 'root@pam',
    status: 'OK',
  };
}

describe('Node Tasks tab footer ("Showing the node\'s last N tasks"), mocked useNodeTasks', () => {
  it('shows the footer when the returned row count equals the 200-row limit', async () => {
    vi.mocked(useNodeTasks).mockReturnValue({
      data: Array.from({ length: 200 }, (_, i) => makeTask(i)),
      isLoading: false,
      isError: false,
      error: null,
    } as ReturnType<typeof useNodeTasks>);

    render(<TasksTab node="pve1" />);

    expect(await screen.findByText("Showing the node's last 200 tasks.")).toBeInTheDocument();
  });

  it('does not show the footer when the returned row count is below the limit', async () => {
    vi.mocked(useNodeTasks).mockReturnValue({
      data: Array.from({ length: 5 }, (_, i) => makeTask(i)),
      isLoading: false,
      isError: false,
      error: null,
    } as ReturnType<typeof useNodeTasks>);

    render(<TasksTab node="pve1" />);

    await screen.findByRole('table');
    expect(screen.queryByText(/Showing the node's last \d+ tasks\./)).toBeNull();
  });
});
