// Builds the static brand assets from the single source of truth in src/brand/mark.ts:
//
//   public/favicon.svg          scalable favicon (heavier weights so 16px still reads)
//   public/favicon.ico          16/32/48 PNG-in-ICO fallback for `/favicon.ico` fetchers
//   public/apple-touch-icon.png 180px, opaque tile (iOS ignores transparency anyway)
//   public/icon-192.png         PWA/manifest icons
//   public/icon-512.png
//   public/logo.svg             the mark on its tile, for README / link previews
//   public/site.webmanifest
//   docs/brand/lockup-{dark,light}.png  mark + PROXION wordmark (Josefin Sans), 2x
//
// The generated files are committed: the app build must not depend on Playwright. Re-run
// this after changing src/brand/mark.ts.
//
// Usage: node scripts/build-icons.ts [previewDir]
//   previewDir (optional): also writes a contact sheet (every size on light + dark) there,
//   for eyeballing the result before committing.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { BRAND_COLORS, MARK_DEFAULT, MARK_FAVICON, markSvg } from '../src/brand/mark.ts';

const WEB_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(WEB_ROOT, '../..');
const PUBLIC_DIR = path.join(WEB_ROOT, 'public');
const BRAND_DOCS_DIR = path.join(REPO_ROOT, 'docs', 'brand');
const PREVIEW_DIR = process.argv[2] ? path.resolve(process.argv[2]) : undefined;

// Embedded as a data URL: a page loaded via `setContent` has an opaque origin and cannot fetch
// `file://` fonts, so a plain file URL silently falls back to the default serif.
const JOSEFIN = `data:font/woff2;base64,${fs
  .readFileSync(
    path.join(
      WEB_ROOT,
      'node_modules/@fontsource-variable/josefin-sans/files/josefin-sans-latin-wght-normal.woff2',
    ),
  )
  .toString('base64')}`;

const faviconSvg = markSvg({ weights: MARK_FAVICON, tile: true });
const logoSvg = markSvg({ weights: MARK_DEFAULT, tile: true });

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Wraps PNG blobs in a Vista+ style .ico (PNG-compressed entries). */
function buildIco(entries: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((entry, i) => {
    const base = i * 16;
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base); // width (0 = 256)
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1); // height
    dir.writeUInt8(0, base + 2); // palette
    dir.writeUInt8(0, base + 3); // reserved
    dir.writeUInt16LE(1, base + 4); // planes
    dir.writeUInt16LE(32, base + 6); // bpp
    dir.writeUInt32LE(entry.png.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += entry.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

function lockupHtml(theme: 'dark' | 'light'): string {
  const bg = theme === 'dark' ? BRAND_COLORS.tile : '#ffffff';
  const fg = theme === 'dark' ? BRAND_COLORS.node : BRAND_COLORS.tile;
  const mark = markSvg({
    weights: MARK_DEFAULT,
    tile: false,
    colors: { node: fg },
    size: 48,
  });
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family: 'Josefin Sans Variable'; src: url('${JOSEFIN}') format('woff2'); font-weight: 100 700; }
    html, body { margin: 0; background: ${bg}; }
    #lockup { display: inline-flex; align-items: center; gap: 14px; padding: 20px 28px 20px 24px;
      font-family: 'Josefin Sans Variable'; font-weight: 600; font-size: 30px; letter-spacing: 0.18em;
      color: ${fg}; line-height: 1; }
    #lockup span { padding-top: 0.14em; /* Josefin sits high on its em box; optical centre */ }
  </style></head><body><div id="lockup">${mark}<span>PROXION</span></div></body></html>`;
}

function previewHtml(): string {
  const sizes = [16, 20, 24, 32, 48, 64, 128];
  const row = (svg: string, label: string) =>
    `<div class="row"><div class="label">${label}</div>${sizes
      .map(
        (s) =>
          `<figure><img src="${svgDataUrl(svg)}" width="${s}" height="${s}"><figcaption>${s}</figcaption></figure>`,
      )
      .join('')}</div>`;
  const tabStrip = (bg: string, fg: string) =>
    `<div class="tab" style="background:${bg};color:${fg}"><img src="${svgDataUrl(faviconSvg)}" width="16" height="16"><span>Proxion</span><span class="x">×</span></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font: 12px system-ui; }
    section { padding: 20px 24px; }
    .dark { background: #202124; color: #e8eaed; } .light { background: #f1f3f4; color: #202124; }
    .row { display: flex; align-items: flex-end; gap: 22px; margin: 10px 0 18px; }
    .label { width: 120px; font-weight: 600; align-self: center; }
    figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; }
    figcaption { opacity: .6; }
    .tab { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 8px 8px 0 0; font: 13px system-ui; margin-right: 12px; }
    .tab .x { opacity: .6; margin-left: 12px; }
  </style></head><body>
  <section class="dark"><h3>Dark tab strip</h3>${tabStrip('#35363a', '#e8eaed')}${row(faviconSvg, 'favicon weights')}${row(logoSvg, 'default weights')}</section>
  <section class="light"><h3>Light tab strip</h3>${tabStrip('#ffffff', '#202124')}${row(faviconSvg, 'favicon weights')}${row(logoSvg, 'default weights')}</section>
  </body></html>`;
}

async function main(): Promise<void> {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  fs.mkdirSync(BRAND_DOCS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PUBLIC_DIR, 'favicon.svg'), faviconSvg + '\n');
  fs.writeFileSync(path.join(PUBLIC_DIR, 'logo.svg'), logoSvg + '\n');

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });

    async function renderPng(svg: string, size: number): Promise<Buffer> {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<!doctype html><html><head><style>html,body{margin:0;background:transparent}img{display:block}</style></head>` +
          `<body><img src="${svgDataUrl(svg)}" width="${size}" height="${size}"></body></html>`,
      );
      await page.waitForLoadState('load');
      return page.screenshot({ omitBackground: true, type: 'png' });
    }

    const png = new Map<number, Buffer>();
    for (const size of [16, 32, 48, 180, 192, 512]) {
      // Favicon weights up to 48px (tab/bookmark sizes), default weights above.
      png.set(size, await renderPng(size <= 48 ? faviconSvg : logoSvg, size));
    }

    fs.writeFileSync(
      path.join(PUBLIC_DIR, 'favicon.ico'),
      buildIco([16, 32, 48].map((size) => ({ size, png: png.get(size)! }))),
    );
    fs.writeFileSync(path.join(PUBLIC_DIR, 'apple-touch-icon.png'), png.get(180)!);
    fs.writeFileSync(path.join(PUBLIC_DIR, 'icon-192.png'), png.get(192)!);
    fs.writeFileSync(path.join(PUBLIC_DIR, 'icon-512.png'), png.get(512)!);

    fs.writeFileSync(
      path.join(PUBLIC_DIR, 'site.webmanifest'),
      JSON.stringify(
        {
          name: 'Proxion',
          short_name: 'Proxion',
          description: 'A modern web console for Proxmox VE.',
          start_url: '/',
          display: 'standalone',
          background_color: BRAND_COLORS.tile,
          theme_color: BRAND_COLORS.tile,
          icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
          ],
        },
        null,
        2,
      ) + '\n',
    );

    // Lockups at 2x for the README (crisp on hi-dpi, downscaled by width in markdown).
    const lockupPage = await browser.newPage({ deviceScaleFactor: 2 });
    for (const theme of ['dark', 'light'] as const) {
      await lockupPage.setContent(lockupHtml(theme));
      await lockupPage.evaluate(() => document.fonts.ready);
      const el = lockupPage.locator('#lockup');
      await el.screenshot({ path: path.join(BRAND_DOCS_DIR, `lockup-${theme}.png`), type: 'png' });
    }
    await lockupPage.close();

    if (PREVIEW_DIR) {
      fs.mkdirSync(PREVIEW_DIR, { recursive: true });
      const preview = await browser.newPage({ deviceScaleFactor: 1 });
      await preview.setViewportSize({ width: 900, height: 620 });
      await preview.setContent(previewHtml());
      await preview.screenshot({ path: path.join(PREVIEW_DIR, 'icons-contact-sheet.png') });
      const zoom = await browser.newPage({ deviceScaleFactor: 8 });
      await zoom.setViewportSize({ width: 120, height: 40 });
      await zoom.setContent(
        `<body style="margin:0;background:#35363a;display:flex;gap:16px;padding:12px">` +
          `<img src="${svgDataUrl(faviconSvg)}" width="16" height="16"><img src="${svgDataUrl(logoSvg)}" width="16" height="16"><img src="${svgDataUrl(faviconSvg)}" width="32" height="32"></body>`,
      );
      await zoom.screenshot({ path: path.join(PREVIEW_DIR, 'icons-16px-zoomed.png') });
      await zoom.close();
      await preview.close();
    }
    await page.close();
  } finally {
    await browser.close();
  }

  for (const f of fs.readdirSync(PUBLIC_DIR)) {
    const st = fs.statSync(path.join(PUBLIC_DIR, f));
    console.log(`${f.padEnd(24)} ${st.size.toString().padStart(7)} bytes`);
  }
  for (const f of fs.readdirSync(BRAND_DOCS_DIR)) {
    const st = fs.statSync(path.join(BRAND_DOCS_DIR, f));
    console.log(`docs/brand/${f.padEnd(13)} ${st.size.toString().padStart(7)} bytes`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
