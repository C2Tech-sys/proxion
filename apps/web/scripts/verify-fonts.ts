// Regression guard + evidence generator for Proxion's T11 typography: Josefin Sans (display,
// titles/big figures/the wordmark) + Open Sans (UI/body/tables/identifiers alike -- no shipped
// monospace webfont any more). Monospace survives only as a SYSTEM stack (`--font-mono`), used
// exclusively by the xterm terminal and the task-log line viewer.
//
// Builds the production (fixture-mode) bundle, serves it via `vite preview`, and asserts (via a
// real Chromium page, not jsdom -- CSS custom properties, @font-face and `document.fonts` don't
// work meaningfully in jsdom) that:
//   1. The *computed* font-family of real elements is Josefin Sans / Open Sans as appropriate:
//      Josefin Sans on the dashboard's h1, a stat-tile value and the wordmark; Open Sans on
//      body, a guest name in the inventory tree, its VMID cell, a table cell, a Hardware-tab
//      volume-id cell, a Hardware-tab MAC cell and a VM Summary IP address.
//   2. `document.fonts` reports Josefin Sans Variable + Open Sans Variable actually loaded
//      (proves the browser fetched and used those families, not just that a CSS variable is
//      set), and that no Source-Code-Pro-family font is loaded at all.
//   3. The `--font-mono` custom property resolves to a literal font-family string that *begins*
//      with the generic `ui-monospace` keyword (a system stack, not a webfont) -- checked both
//      as a raw custom-property read and via the same probe-element technique the terminal's
//      `readCssFontFamily` helper (components/console/theme.ts) actually uses at runtime, so
//      this proves what the terminal really resolves its font from.
//
// Exits non-zero (and prints exactly what mismatched) if any of the above fails.
//
// Usage: node scripts/verify-fonts.ts (wired as `pnpm --filter @proxion/web verify:fonts`)
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Page } from '@playwright/test';
import path from 'node:path';

const PORT = 5185;

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

const DISPLAY = 'Josefin Sans Variable';
const SANS = 'Open Sans Variable';
/** T11: no shipped mono webfont -- `--font-mono` must be a system stack, so its first family is
 * this generic CSS keyword rather than a quoted font name. */
const MONO_SYSTEM_PREFIX = 'ui-monospace';

/** First font-family in a computed `font-family` list, unquoted, for a loose string compare. */
function firstFamily(computed: string): string {
  return (computed.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');
}

async function computedFontFamily(page: Page, selector: string): Promise<string | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return getComputedStyle(el).fontFamily;
  }, selector);
}

/**
 * Resolves a CSS custom property to a font-family via the same probe-element technique as
 * `components/console/theme.ts`'s `readCssFontFamily` (which the terminal actually uses at
 * runtime) -- proves the token the terminal reads its font from, not just a DOM element's class.
 */
async function resolvedFontFamilyVar(page: Page, token: string): Promise<string> {
  return page.evaluate((t) => {
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.fontFamily = `var(${t})`;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).fontFamily;
    document.body.removeChild(probe);
    return resolved;
  }, token);
}

async function loadedFamilies(page: Page): Promise<Set<string>> {
  await page.evaluate(() => document.fonts.ready);
  return new Set(
    await page.evaluate(() =>
      Array.from(document.fonts)
        .filter((f) => f.status === 'loaded')
        .map((f) => f.family.replace(/^["']|["']$/g, '')),
    ),
  );
}

interface Row {
  element: string;
  expected: string;
  computed: string;
  ok: boolean;
}

async function main() {
  const root = path.resolve(import.meta.dirname, '..');
  process.env.VITE_USE_FIXTURES = '1';

  console.log('Building production bundle (VITE_USE_FIXTURES=1)...');
  await buildWithRetry({ root, logLevel: 'warn' });

  const server: PreviewServer = await preview({ root, preview: { port: PORT, strictPort: true } });
  const base = (server.resolvedUrls?.local[0] ?? `http://localhost:${PORT}/`).replace(/\/$/, '');
  console.log(`Preview server up at ${base}`);

  const browser = await chromium.launch();
  const rows: Row[] = [];
  let anyFail = false;

  function check(element: string, expected: string, computed: string | null) {
    const got = computed ?? '(element not found)';
    const ok = computed !== null && firstFamily(got).toLowerCase() === expected.toLowerCase();
    rows.push({ element, expected, computed: got, ok });
    if (!ok) anyFail = true;
  }

  /** Like `check`, but passes when the computed/resolved value's first family *starts with* the
   * expected generic keyword (used for `--font-mono`'s system stack, whose exact resolved font
   * name is platform-dependent -- only the leading `ui-monospace` keyword is guaranteed). */
  function checkPrefix(element: string, expectedPrefix: string, computed: string | null) {
    const got = computed ?? '(element not found)';
    const ok = computed !== null && firstFamily(got).toLowerCase().startsWith(expectedPrefix.toLowerCase());
    rows.push({ element, expected: `starts with "${expectedPrefix}"`, computed: got, ok });
    if (!ok) anyFail = true;
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // --- Dashboard: body, h1, stat-tile value, guest name, VMID cell, table cell, wordmark ----
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.getByText('Virtual machines').waitFor();

  check('body', SANS, await computedFontFamily(page, 'body'));
  check('h1 (dashboard heading)', DISPLAY, await computedFontFamily(page, 'h1'));
  check(
    'stat-tile value (dashboard)',
    DISPLAY,
    await computedFontFamily(page, '[data-testid="stat-value"]'),
  );
  check(
    'guest name (inventory tree)',
    SANS,
    await computedFontFamily(page, 'a[href*="/vm/pve1/qemu/100"] span.truncate'),
  );
  check(
    'VMID cell (inventory tree)',
    SANS,
    await computedFontFamily(page, 'a[href*="/vm/pve1/qemu/100"] [data-testid="guest-vmid"]'),
  );
  check('wordmark (PROXION)', DISPLAY, await computedFontFamily(page, 'header a.font-display'));

  const dashboardFonts = await loadedFamilies(page);
  const displayLoaded = dashboardFonts.has(DISPLAY);
  const sansLoaded = dashboardFonts.has(SANS);
  const noMonoWebfontOnDashboard = ![...dashboardFonts].some((f) => /source code pro/i.test(f));
  rows.push({
    element: 'document.fonts (dashboard)',
    expected: `${DISPLAY} + ${SANS} loaded, no Source-Code-Pro`,
    computed: [...dashboardFonts].join(' | ') || '(none loaded)',
    ok: displayLoaded && sansLoaded && noMonoWebfontOnDashboard,
  });
  if (!displayLoaded || !sansLoaded || !noMonoWebfontOnDashboard) anyFail = true;

  // --- Tasks page: a plain table cell (Open Sans) ---------------------------------------
  await page.goto(`${base}/tasks`, { waitUntil: 'networkidle' });
  await page.getByText('Tasks').first().waitFor();
  check('table cell (tasks)', SANS, await computedFontFamily(page, '[data-testid="table-cell"]'));

  // --- Hardware tab: a volume-id cell and a MAC cell -- both Open Sans, no mono webfont (T11)
  await page.goto(`${base}/vm/pve1/qemu/100?tab=hardware`, { waitUntil: 'networkidle' });
  await page.getByText('Processors').waitFor();
  check(
    'hardware volume-id cell',
    SANS,
    await computedFontFamily(page, '[data-testid="volume-id"]'),
  );
  check('hardware MAC cell', SANS, await computedFontFamily(page, '[data-testid="hardware-mac"]'));

  const hardwareFonts = await loadedFamilies(page);
  const noMonoWebfontOnHardware = ![...hardwareFonts].some((f) => /source code pro/i.test(f));
  rows.push({
    element: 'document.fonts (hardware, no mono webfont)',
    expected: 'no Source-Code-Pro family loaded',
    computed: [...hardwareFonts].join(' | ') || '(none loaded)',
    ok: noMonoWebfontOnHardware,
  });
  if (!noMonoWebfontOnHardware) anyFail = true;

  // --- VM Summary tab: an IP address -- Open Sans, not mono (T11) -----------------------
  await page.goto(`${base}/vm/pve1/qemu/100`, { waitUntil: 'networkidle' });
  await page.locator('[data-testid="guest-ip"]').first().waitFor();
  check('VM Summary IP address', SANS, await computedFontFamily(page, '[data-testid="guest-ip"]'));

  // --- Terminal theme font: the `--font-mono` token the terminal resolves its xterm.js
  // fontFamily from (see components/console/theme.ts's readCssFontFamily) must be a SYSTEM
  // monospace stack (T11: no shipped mono webfont), checked both as a raw custom-property
  // read and via the same probe-element technique the terminal helper itself uses. --------
  const rawFontMonoVar = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
  );
  checkPrefix('--font-mono custom property (raw)', MONO_SYSTEM_PREFIX, rawFontMonoVar);

  const terminalThemeFont = await resolvedFontFamilyVar(page, '--font-mono');
  checkPrefix('terminal theme font (readCssFontFamily helper)', MONO_SYSTEM_PREFIX, terminalThemeFont);

  await context.close();
  await browser.close();
  await server.close();

  const pad = (s: string, n: number) => s.padEnd(n);
  console.log('\nComputed font-family table (element | expected | computed | ok):');
  for (const r of rows) {
    console.log(
      `${pad(r.element, 30)} | ${pad(r.expected, 24)} | ${pad(r.computed, 50)} | ${r.ok ? 'OK' : 'FAIL'}`,
    );
  }

  if (anyFail) {
    console.error('\nFAIL: at least one element did not match the expected Josefin Sans / Open Sans / system-mono typography.');
    process.exit(1);
  }
  console.log('\nOK: every checked element computed to Josefin Sans / Open Sans, and --font-mono resolves to a system stack.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
