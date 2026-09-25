// Foreman review screenshots for the Proxion shell (fixture mode).
//
// Runs against `vite preview` of a fresh production build with VITE_USE_FIXTURES=1 (not the
// dev server): deterministic, and immune to Vite's dev-only "optimized dependencies changed,
// reloading" cold-cache reload, since a production build has no on-demand dep pre-bundling.
// `gotoWithRetry` still retries the first navigation once, belt-and-suspenders.
//
// A second, later stage does the same for the console/shell "live mock" screenshots
// (node-shell-mock-*, shell-popout-dark): those need a running mock term websocket bridge
// (scripts/mock-term-server.ts, port 3099) and Terminal.tsx pointed at it via
// VITE_MOCK_TERM_WS, which it only reads in dev or in a `--mode screenshot` build (see the
// gate in src/components/console/Terminal.tsx) -- so this stage does its own preview build,
// built with `mode: 'screenshot'`, on its own port, and never touches the main production
// build used for every other case.
//
// Usage: node scripts/screenshot.ts [outDir]
//
// To add a new screenshot case (e.g. from another ticket), append an entry to
// SCREENSHOT_CASES below -- keep the `{ name, theme, run }` shape so this file's
// main() doesn't need to change. A case that needs the mock term websocket bridge instead
// goes in MOCK_TERM_SCREENSHOT_CASES.
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';

const OUT_DIR = process.argv[2] ?? path.resolve(process.cwd(), 'screenshots');

/** Belt-and-suspenders retry for `vite build()` on this Dropbox-synced checkout: Vite's own
 *  `emptyOutDir` step (which runs before every build) can hit `EPERM` if Dropbox is mid-sync
 *  and still holds a handle into `dist/` -- transient, and gone within a couple of retries, but
 *  otherwise fatal to the whole script even though nothing is actually wrong with the build
 *  itself. Same idea as the `dist-screenshot` cleanup retry further down, just for the build
 *  step instead of the delete step. */
async function buildWithRetry(options: Parameters<typeof build>[0], attempts = 3): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await build(options);
      return;
    } catch (err) {
      const isEperm = err instanceof Error && /EPERM/.test(err.message);
      if (!isEperm || attempt === attempts) throw err;
      console.warn(`Build hit a transient EPERM (attempt ${attempt}/${attempts}), retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

export interface ScreenshotCase {
  /** Output file is `${name}-${theme}.png`. */
  name: string;
  theme: 'dark' | 'light';
  /** Navigates `page` (against `base`) and waits until the page is ready to screenshot. */
  run: (page: Page, base: string) => Promise<void>;
  /** Captures the full scrollable page instead of just the viewport (e.g. the font lab). */
  fullPage?: boolean;
}

/** Navigates once, retrying a single time on failure (e.g. a slow first paint). */
async function gotoWithRetry(
  page: Page,
  url: string,
  waitFor: () => Promise<unknown>,
): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    await waitFor();
  } catch {
    await page.goto(url, { waitUntil: 'networkidle' });
    await waitFor();
  }
}

async function gotoDashboard(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/`, () => page.getByText('Virtual machines').waitFor());
}

async function gotoVmSummary(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/vm/pve1/qemu/100`, () =>
    page.getByRole('heading', { name: 'Guest' }).waitFor(),
  );
}

async function gotoTasks(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/tasks`, () =>
    page.getByRole('heading', { name: 'Tasks' }).waitFor(),
  );
}

async function gotoCommandPalette(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/`, () => page.getByText('Virtual machines').waitFor());
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder(/Search nodes/).waitFor();
  await page.waitForTimeout(150);
}

async function gotoVmMonitor(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/vm/pve1/qemu/100?tab=monitor&range=day`, async () => {
    await page.getByRole('heading', { name: 'CPU' }).waitFor();
    await page.waitForTimeout(200);
  });
}

async function gotoNodeMonitor(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/node/pve1?tab=monitor&range=hour`, async () => {
    await page.getByRole('heading', { name: 'CPU' }).waitFor();
    await page.waitForTimeout(200);
  });
}

/** Regression coverage for the week-range x-axis tick collision (see chart-types.ts). */
async function gotoNodeMonitorWeek(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/node/pve1?tab=monitor&range=week`, async () => {
    await page.getByRole('heading', { name: 'CPU' }).waitFor();
    await page.waitForTimeout(200);
  });
}

/** Fixture mode renders the console toolbar disabled, with an EmptyState in place of a live
 * RFB/xterm session (no Proxion server in fixture mode). */
async function gotoVmConsoleFixture(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/vm/pve1/qemu/100?tab=console`, () =>
    page.getByText('Console needs a connected Proxion server').waitFor(),
  );
}

async function gotoNodeShellMock(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/node/pve1?tab=shell`, () =>
    page.getByText('mock@proxion').waitFor(),
  );
}

async function gotoShellPopout(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/shell/pve1`, () => page.getByText('mock@proxion').waitFor());
}

async function gotoNodeSummary(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/node/pve1?tab=summary`, () =>
    page.getByText('PVE version').waitFor(),
  );
}

async function gotoNodeStorage(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/node/pve1?tab=storage`, () =>
    page.getByRole('cell', { name: 'tank-backups' }).waitFor(),
  );
}

async function gotoVmHardware(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/vm/pve1/qemu/100?tab=hardware`, () =>
    page.getByText('Processors').waitFor(),
  );
}

async function gotoVmSnapshots(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/vm/pve1/qemu/100?tab=snapshots`, () =>
    page.getByText('pre-upgrade').waitFor(),
  );
}

/** T26: snapshot create/delete/rollback -- the row "…" menu open on a real snapshot. */
async function gotoVmSnapshotsActions(page: Page, base: string) {
  await gotoVmSnapshots(page, base);
  await page.getByRole('button', { name: 'Actions for pre-upgrade' }).click();
  await page.getByRole('menuitem', { name: /Roll back/ }).waitFor();
}

/** T26: the "Take snapshot" create dialog. */
async function gotoVmSnapshotCreateDialog(page: Page, base: string) {
  await gotoVmSnapshots(page, base);
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  await page.getByRole('textbox', { name: 'Snapshot name' }).waitFor();
}

/** T26: the destructive rollback confirmation. */
async function gotoVmSnapshotRollbackDialog(page: Page, base: string) {
  await gotoVmSnapshotsActions(page, base);
  await page.getByRole('menuitem', { name: /Roll back/ }).click();
  await page.getByRole('alertdialog').waitFor();
  await page.getByText('Start the guest afterwards').waitFor();
}

async function gotoVmBackups(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/vm/pve1/qemu/100?tab=backups`, () =>
    page.getByText('Volume ID').waitFor(),
  );
}

async function gotoLxcHardware(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/vm/pve1/lxc/200?tab=hardware`, () =>
    page.getByText('Root Disk (rootfs)').waitFor(),
  );
}

/** T14b: the dashboard's "Consoles" panel of running-guest thumbnails. Waits for the panel's
 *  own count header, then a beat for the visible tiles' fixture-placeholder fetch to resolve
 *  (IntersectionObserver fires as soon as they're in the (unscrolled) viewport here). */
async function gotoDashboardConsoles(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/`, () => page.getByText(/Consoles \(\d+\)/).waitFor());
  await page.waitForTimeout(300);
}

/** T14b: the VM Summary tab's own larger (w=800) Console thumbnail panel. */
async function gotoVmSummaryConsole(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/vm/pve1/qemu/100`, () =>
    page.getByRole('heading', { name: 'Console' }).waitFor(),
  );
  await page.waitForTimeout(300);
}

/** T17: the VM Tasks tab against a guest with deep (fixture-extended) task history -- vmid 102
 *  (db-prod-01) has 25+ rows once the node's own task index is read instead of the cluster's
 *  short recent-task list. */
async function gotoVmTasksDeepHistory(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/vm/pve1/qemu/102?tab=tasks`, () =>
    page.getByRole('table').waitFor(),
  );
}

/** T17: the node Tasks tab, same fix -- real per-node task-index history instead of the last
 *  few hours of the cluster's recent-task list. */
async function gotoNodeTasksDeepHistory(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/node/pve1?tab=tasks`, () =>
    page.getByRole('table').waitFor(),
  );
}

async function gotoTasksWithLogSheet(page: Page, base: string) {
  await gotoTasks(page, base);
  await page.locator('tbody tr').first().click();
  await page.getByRole('dialog').waitFor();
  await page.waitForTimeout(150);
}

/** T19: guest power actions. Fixture mode has no real session concept, so the demo's own
 *  carve-out (see ObjectHeader.tsx/InventoryTree.tsx) always shows the enabled state here. */
async function gotoVmSummaryActions(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/vm/pve1/qemu/100`, () =>
    page.getByRole('button', { name: 'Shut down' }).waitFor(),
  );
}

async function gotoVmActionDialog(page: Page, base: string) {
  await gotoVmSummaryActions(page, base);
  await page.getByRole('button', { name: 'Shut down' }).click();
  await page.getByRole('alertdialog').waitFor();
  await page.getByText('Force stop after timeout').waitFor();
}

async function gotoTreeContextActions(page: Page, base: string) {
  const treeRow = () => page.getByRole('tree', { name: 'Inventory' }).getByText('web-prod-01');
  await gotoWithRetry(page, `${base}/`, () => treeRow().waitFor());
  await treeRow().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Shut down' }).waitFor();
}

/** T21: the rename dialog, opened via the VM Summary header's "More" menu. Fixture mode's
 *  always-enabled carve-out (see ObjectHeader.tsx) means "Rename…" is enabled with no
 *  auth/permission setup needed here, same as the power-action screenshots above. */
async function gotoVmRenameDialog(page: Page, base: string) {
  await gotoVmSummaryActions(page, base);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Rename/ }).click();
  await page.getByRole('textbox', { name: 'Guest name' }).waitFor();
}

/** T21: the Notes panel's editor, opened via its header "Edit notes" button. */
async function gotoVmNotesEditing(page: Page, base: string) {
  await gotoVmSummary(page, base);
  await page.getByRole('button', { name: 'Edit notes' }).click();
  await page.getByRole('textbox', { name: 'Notes' }).waitFor();
}

/** T18: the Preferences page. */
async function gotoPreferences(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/preferences`, () =>
    page.getByRole('heading', { name: 'Preferences' }).waitFor(),
  );
  await page.waitForTimeout(150);
}

/** T18: `density: compact` applied app-wide (tighter table rows and panel padding) -- flips it
 *  on the Preferences page, then navigates back to the dashboard via an in-app `<Link>` click
 *  (never `page.goto`, which would reload the page and reset fixture mode's in-memory prefs
 *  store back to its defaults). */
async function gotoDashboardCompact(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/preferences`, () =>
    page.getByRole('heading', { name: 'Preferences' }).waitFor(),
  );
  await page.getByRole('group', { name: 'Density' }).getByRole('button', { name: 'Compact' }).click();
  await page.getByText('Saved').waitFor();
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: 'Datacenter' })
    .click();
  await page.getByText('Virtual machines').waitFor();
  await page.waitForTimeout(200);
}

/**
 * T23: the dashboard alerts strip with all three states (error, warning, and the "Recently
 * healed" disclosure opened) -- from the backup-incident demo data in fixtures/tasks.json
 * (VMIDs 300-305).
 */
async function gotoDashboardAlerts(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/`, () => page.getByText('Virtual machines').waitFor());
  const healedToggle = page.getByRole('button', { name: /Recently healed/ });
  await healedToggle.waitFor();
  await healedToggle.click();
  await page.waitForTimeout(150);
}

/** T23: the VM Summary "Last backup" panel's muted healed line (vmid 300 -- app-prod-01). */
async function gotoVmSummaryBackupHealed(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/vm/pve1/qemu/300`, () =>
    page.getByRole('heading', { name: 'Guest' }).waitFor(),
  );
  const healedLine = page.getByText(/healed by retry at/);
  await healedLine.waitFor();
  // Fixture-mode data loads via in-memory setTimeout delays (not real network requests), so
  // sibling panels can keep growing/reflowing after this line first appears -- settle, scroll,
  // then settle and re-scroll once more before the shot (the panel above can still grow once).
  await page.waitForTimeout(1000);
  await healedLine.evaluate((el) => el.scrollIntoView({ block: 'end' }));
  await page.waitForTimeout(1000);
  await healedLine.evaluate((el) => el.scrollIntoView({ block: 'end' }));
  await page.waitForTimeout(300);
}

/** T22: Summary tab arrange mode -- drag handles + Move up/down buttons visible in every
 *  panel's header. */
async function gotoVmSummaryArrange(page: Page, base: string) {
  await gotoVmSummary(page, base);
  await page.getByRole('button', { name: 'Arrange' }).click();
  await page.getByTestId('drag-handle').first().waitFor();
  await page.waitForTimeout(200);
}

/** T22: Summary tab after moving Notes to the top of the order (four "Move Notes up" clicks
 *  from its default 5th position), then leaving arrange mode -- the saved order persists
 *  through the fixture prefs store, same path a real drag-and-drop reorder writes through.
 *  Each click waits out the fixture's own simulated round-trip (`FIXTURE_LATENCY_MS` in
 *  `api/prefs.ts`, 300ms) before the next: `useUpdatePrefs`'s `onSuccess` replaces the whole
 *  cached document with that call's own resolved response, so firing the next PATCH before this
 *  one settles can have its optimistic update overwritten by an earlier, slower-resolving one --
 *  a real race in the hook, out of this ticket's write set to fix, and avoided here simply by not
 *  triggering it. */
async function gotoVmSummaryReordered(page: Page, base: string) {
  await gotoVmSummary(page, base);
  await page.getByRole('button', { name: 'Arrange' }).click();
  const moveNotesUp = page.getByRole('button', { name: 'Move Notes up' });
  await moveNotesUp.waitFor();
  for (let i = 0; i < 4; i++) {
    await moveNotesUp.click();
    await page.waitForTimeout(500);
  }
  await page.getByRole('button', { name: 'Done' }).click();
  await page.waitForTimeout(300);
}

/** T25: the Guests page (cluster-wide VMs & Templates table). */
async function gotoGuests(page: Page, base: string) {
  await gotoWithRetry(page, `${base}/guests`, () => page.getByRole('heading', { name: 'Guests' }).waitFor());
  await page.waitForTimeout(150);
}

/** T25: filtered (status=running, type=qemu) and sorted by memory descending. */
async function gotoGuestsFiltered(page: Page, base: string) {
  await gotoWithRetry(
    page,
    `${base}/guests?status=running&type=qemu&sort=mem&dir=desc`,
    () => page.getByRole('heading', { name: 'Guests' }).waitFor(),
  );
  await page.getByRole('table').waitFor();
  await page.waitForTimeout(150);
}

/** T25: the Guests table's row context menu -- the same shared `GuestContextMenu` the inventory
 *  rail uses. */
async function gotoGuestsContextMenu(page: Page, base: string) {
  await gotoGuests(page, base);
  const table = page.getByRole('table');
  const nameCell = table.getByText('web-prod-01');
  await nameCell.waitFor();
  await nameCell.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Shut down' }).waitFor();
}

/** The screenshot cases this ticket needs. Other tickets append cases here. */
export const SCREENSHOT_CASES: ScreenshotCase[] = [
  { name: 'dashboard', theme: 'dark', run: gotoDashboard },
  { name: 'dashboard', theme: 'light', run: gotoDashboard },
  { name: 'vm-summary', theme: 'dark', run: gotoVmSummary },
  { name: 'vm-summary', theme: 'light', run: gotoVmSummary },
  { name: 'tasks', theme: 'dark', run: gotoTasks },
  { name: 'tasks', theme: 'light', run: gotoTasks },
  { name: 'command-palette', theme: 'dark', run: gotoCommandPalette },
  { name: 'command-palette', theme: 'light', run: gotoCommandPalette },
  { name: 'vm-monitor', theme: 'dark', run: gotoVmMonitor },
  { name: 'vm-monitor', theme: 'light', run: gotoVmMonitor },
  { name: 'node-monitor', theme: 'dark', run: gotoNodeMonitor },
  { name: 'node-monitor', theme: 'light', run: gotoNodeMonitor },
  { name: 'node-monitor-week', theme: 'dark', run: gotoNodeMonitorWeek },
  { name: 'vm-console-fixture', theme: 'dark', run: gotoVmConsoleFixture },
  { name: 'node-summary', theme: 'dark', run: gotoNodeSummary },
  { name: 'node-storage', theme: 'dark', run: gotoNodeStorage },
  { name: 'vm-hardware', theme: 'dark', run: gotoVmHardware },
  { name: 'vm-snapshots', theme: 'dark', run: gotoVmSnapshots },
  { name: 'vm-backups', theme: 'dark', run: gotoVmBackups },
  { name: 'lxc-hardware', theme: 'dark', run: gotoLxcHardware },
  { name: 'tasks-log-sheet', theme: 'dark', run: gotoTasksWithLogSheet },
  // T7: breadcrumb trail above each page header (Datacenter -> ... -> current page).
  { name: 'tasks-breadcrumb', theme: 'dark', run: gotoTasks },
  { name: 'node-summary-breadcrumb', theme: 'dark', run: gotoNodeSummary },
  // T14b: VM console thumbnails (dashboard "Consoles" panel + VM Summary's own Console panel).
  { name: 'dashboard-consoles', theme: 'dark', run: gotoDashboardConsoles },
  { name: 'dashboard-consoles', theme: 'light', run: gotoDashboardConsoles },
  { name: 'vm-summary-console', theme: 'dark', run: gotoVmSummaryConsole },
  // T17: per-node task index (Last backup panel + node/VM Tasks tabs deep history).
  { name: 'vm-tasks', theme: 'dark', run: gotoVmTasksDeepHistory },
  { name: 'node-tasks', theme: 'dark', run: gotoNodeTasksDeepHistory },
  // T19: guest power actions.
  { name: 'vm-summary-actions', theme: 'dark', run: gotoVmSummaryActions },
  { name: 'vm-action-dialog', theme: 'dark', run: gotoVmActionDialog },
  { name: 'tree-context-actions', theme: 'dark', run: gotoTreeContextActions },
  // T18: per-user preferences page + density.
  { name: 'preferences', theme: 'dark', run: gotoPreferences },
  { name: 'preferences', theme: 'light', run: gotoPreferences },
  { name: 'dashboard-compact', theme: 'dark', run: gotoDashboardCompact },
  // T21: guest rename + notes editing.
  { name: 'vm-rename-dialog', theme: 'dark', run: gotoVmRenameDialog },
  { name: 'vm-notes-editing', theme: 'dark', run: gotoVmNotesEditing },
  { name: 'dashboard-alerts', theme: 'dark', run: gotoDashboardAlerts },
  { name: 'vm-summary-backup-healed', theme: 'dark', run: gotoVmSummaryBackupHealed },
  // T22: Summary tab arrange mode + a saved custom order.
  { name: 'vm-summary-arrange', theme: 'dark', run: gotoVmSummaryArrange },
  { name: 'vm-summary-reordered', theme: 'dark', run: gotoVmSummaryReordered },
  // T25: the Guests page (cluster-wide VMs & Templates table).
  { name: 'guests', theme: 'dark', run: gotoGuests },
  { name: 'guests', theme: 'light', run: gotoGuests },
  { name: 'guests-filtered', theme: 'dark', run: gotoGuestsFiltered },
  { name: 'guests-context-menu', theme: 'dark', run: gotoGuestsContextMenu },
  // T26: snapshot create/delete/rollback.
  { name: 'vm-snapshots-actions', theme: 'dark', run: gotoVmSnapshotsActions },
  { name: 'vm-snapshot-create', theme: 'dark', run: gotoVmSnapshotCreateDialog },
  { name: 'vm-snapshot-rollback', theme: 'dark', run: gotoVmSnapshotRollbackDialog },
];

/**
 * Cases that need a live mock term websocket bridge (scripts/mock-term-server.ts) and a
 * Terminal.tsx build pointed at it via VITE_MOCK_TERM_WS. Captured against a second,
 * `mode: 'screenshot'` preview build so the ordinary production build (and every case above)
 * never sees that env var.
 */
export const MOCK_TERM_SCREENSHOT_CASES: ScreenshotCase[] = [
  { name: 'node-shell-mock', theme: 'dark', run: gotoNodeShellMock },
  { name: 'node-shell-mock', theme: 'light', run: gotoNodeShellMock },
  { name: 'shell-popout', theme: 'dark', run: gotoShellPopout },
];

const MOCK_TERM_WS_PORT = 3099;

/** Spawns scripts/mock-term-server.ts and resolves once it reports it is listening. */
function startMockTermServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.resolve(import.meta.dirname, 'mock-term-server.ts')],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    const onData = (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('listening on')) {
        child.stdout?.off('data', onData);
        resolve(child);
      }
    };
    child.stdout?.on('data', onData);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== null && code !== 0)
        reject(new Error(`mock-term-server exited with code ${code}`));
    });
  });
}

/** Stops a spawned child process and waits for it to actually exit (so the port is free). */
function stopChildProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill();
  });
}

async function captureCases(
  cases: ScreenshotCase[],
  base: string,
  browser: import('@playwright/test').Browser,
  written: string[],
): Promise<void> {
  for (const shot of cases) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: shot.theme,
    });
    // These are README/docs screenshots of the real product, not the GitHub Pages demo -- the
    // fixture-mode-only <DemoBanner/> would otherwise show up under the top bar here (fixture
    // mode is exactly how this script builds the app). Pre-dismiss it the same way a returning
    // visitor's browser would, before any page script runs.
    await context.addInitScript(() => {
      try {
        localStorage.setItem('proxion.demoBanner.dismissed', '1');
      } catch {
        // ignore (shouldn't happen in a fresh Playwright context, but never fail the shot over it)
      }
    });
    const page = await context.newPage();

    await shot.run(page, base);
    await page.waitForTimeout(150);

    const filePath = path.join(OUT_DIR, `${shot.name}-${shot.theme}.png`);
    await page.screenshot({ path: filePath, fullPage: shot.fullPage ?? false });
    written.push(filePath);
    await context.close();
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  process.env.VITE_USE_FIXTURES = '1';
  const root = path.resolve(import.meta.dirname, '..');

  const written: string[] = [];

  console.log('Building production bundle (VITE_USE_FIXTURES=1)...');
  await buildWithRetry({ root, logLevel: 'warn' });

  const browser = await chromium.launch();

  const server: PreviewServer = await preview({
    root,
    preview: { port: 5183, strictPort: true },
  });
  const base = (server.resolvedUrls?.local[0] ?? 'http://localhost:5183/').replace(/\/$/, '');
  console.log(`Preview server up at ${base}`);

  await captureCases(SCREENSHOT_CASES, base, browser, written);

  await server.close();

  // --- Console/shell mock-term-server shots -------------------------------------------
  // These need VITE_MOCK_TERM_WS set before the build runs (Terminal.tsx reads it as a
  // build-time env var), so they get their own preview build on a different port -- built
  // with `mode: 'screenshot'` so the flag is only read there, never in the plain production
  // build above.
  const mockServer = await startMockTermServer();
  try {
    process.env.VITE_MOCK_TERM_WS = `ws://localhost:${MOCK_TERM_WS_PORT}/term`;

    // A separate outDir (rather than reusing `dist`) avoids re-deleting the just-built
    // production `dist/assets` -- on a Dropbox-synced checkout that directory can still be
    // mid-sync and briefly locked (EPERM) right after the first preview server closes.
    console.log('Building screenshot-mode bundle (VITE_MOCK_TERM_WS set)...');
    await buildWithRetry({
      root,
      mode: 'screenshot',
      logLevel: 'warn',
      build: { outDir: 'dist-screenshot' },
    });

    const termServer: PreviewServer = await preview({
      root,
      mode: 'screenshot',
      build: { outDir: 'dist-screenshot' },
      preview: { port: 5184, strictPort: true },
    });
    const termBase = (termServer.resolvedUrls?.local[0] ?? 'http://localhost:5184/').replace(
      /\/$/,
      '',
    );
    console.log(`Preview server (mock term) up at ${termBase}`);

    try {
      await captureCases(MOCK_TERM_SCREENSHOT_CASES, termBase, browser, written);
    } finally {
      await termServer.close();
      // On this Dropbox-synced checkout, Dropbox can still hold a handle into `dist-screenshot`
      // (mid-sync) right after the preview server closes, so a plain `rmSync` throws EPERM here
      // and takes the whole script down with it -- even though every screenshot had already
      // been written successfully. `maxRetries`/`retryDelay` ride out that transient lock; if
      // it's *still* held after retrying, this is just cleanup of a scratch build directory
      // (not a screenshot result), so it's a warning, not a fatal error -- the leftover
      // directory is also `.gitignore`d (see root .gitignore) so it can't be committed by
      // accident.
      try {
        fs.rmSync(path.join(root, 'dist-screenshot'), {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
        });
      } catch (err) {
        console.warn('Could not remove dist-screenshot/ (leaving it for next time):', err);
      }
    }
  } finally {
    delete process.env.VITE_MOCK_TERM_WS;
    await stopChildProcess(mockServer);
  }

  await browser.close();

  console.log('Wrote screenshots:');
  for (const f of written) console.log(` - ${f}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
