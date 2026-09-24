// Records the README tour GIF (docs/media/proxion-tour.gif) -- a fixture-mode walkthrough of
// the dashboard, a VM's Summary/Monitor tabs, the guest power-action confirmation dialog, and
// the Preferences theme switch.
//
// Same production build recipe as scripts/screenshot.ts (VITE_USE_FIXTURES=1, `vite build` +
// `vite preview`), but drives one long-lived page instead of many short-lived ones, inside a
// context created with Playwright's own `recordVideo` (webm; Chromium's built-in encoder, not
// ffmpeg -- ffmpeg only enters the pipeline afterward, to convert that webm to a GIF).
//
// Usage: node scripts/record-tour.ts [outDir]
//
// Two ffmpeg builds are involved, deliberately different ones:
//  - Playwright's own bundled ffmpeg (apps/web/node_modules or %LOCALAPPDATA%/ms-playwright/
//    ffmpeg-*/ffmpeg-win64.exe) is what Playwright's *browser* uses internally to mux the
//    recorded frames into the .webm this script gets from `page.video()`. This script never
//    invokes that binary directly.
//  - Converting that .webm to an animated GIF (the two-pass palette recipe: `palettegen` then
//    `paletteuse`) needs an ffmpeg build with the `gif` encoder and `palettegen`/`paletteuse`
//    filters. Playwright's bundled ffmpeg is built with `--disable-everything` and only enables
//    exactly the encoders/filters/muxers its own video pipeline needs (`libvpx`/`png`,
//    `scale`, `webm`/`image2`) -- confirmed via `ffmpeg -encoders`/`-filters` on the copy at
//    ms-playwright/ffmpeg-1011: no `gif` encoder, no `palette*` filter, not even `fps`. So this
//    script shells out to a regular full ffmpeg build on PATH instead (already installed on
//    this machine via winget, `ffmpeg version 9.0-full_build`; nothing downloaded for this
//    ticket) for the GIF conversion step only. If neither that nor `FFMPEG_PATH` is set, this
//    script leaves the .webm in place and says so, per the ticket's documented fallback.
import { build, preview, type PreviewServer } from 'vite';
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const OUT_DIR = process.argv[2] ?? path.resolve(process.cwd(), 'docs/media');
const VIDEO_DIR = path.join(OUT_DIR, '.video-tmp');
const GIF_PATH = path.join(OUT_DIR, 'proxion-tour.gif');
const WEBM_PATH = path.join(OUT_DIR, 'proxion-tour.webm');
const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 800;
// The GIF is downsized from the recorded 1280x800 to keep the file under the README's 4MB
// budget (a straight 1280-wide, 12fps, full-palette GIF of this tour came out around 10MB) --
// it's displayed at `width="900"` in the README anyway, so 800px source detail is plenty.
const GIF_WIDTH = 800;
const GIF_FPS = 8;

/** A full ffmpeg build with `gif`/`palettegen`/`paletteuse` -- see the header comment above for
 *  why this is deliberately not Playwright's own bundled copy. `FFMPEG_PATH` overrides. */
function findFullFfmpeg(): string | null {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  const candidates = process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg'];
  for (const name of candidates) {
    try {
      const where = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], {
        encoding: 'utf8',
      })
        .split(/\r?\n/)[0]
        ?.trim();
      if (where && fs.existsSync(where)) return where;
    } catch {
      // not on PATH, try the next candidate
    }
  }
  return null;
}

/** True if this ffmpeg build actually has what the GIF conversion needs (Playwright's bundled
 *  one, on PATH or not, does not -- see header comment). */
function ffmpegSupportsGif(ffmpeg: string): boolean {
  try {
    const filters = execFileSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' });
    const encoders = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    return /palettegen/.test(filters) && /paletteuse/.test(filters) && /\bgif\b/.test(encoders);
  } catch {
    return false;
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(VIDEO_DIR, { recursive: true });

  process.env.VITE_USE_FIXTURES = '1';
  const root = path.resolve(import.meta.dirname, '..');

  console.log('Building production bundle (VITE_USE_FIXTURES=1)...');
  await build({ root, logLevel: 'warn' });

  const server: PreviewServer = await preview({ root, preview: { port: 5187, strictPort: true } });
  const base = (server.resolvedUrls?.local[0] ?? 'http://localhost:5187/').replace(/\/$/, '');
  console.log(`Preview server up at ${base}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: FRAME_WIDTH, height: FRAME_HEIGHT },
    colorScheme: 'dark',
    recordVideo: { dir: VIDEO_DIR, size: { width: FRAME_WIDTH, height: FRAME_HEIGHT } },
  });
  // README media, not the GitHub Pages demo itself -- same reasoning as screenshot.ts's
  // pre-dismissal: the fixture-mode-only <DemoBanner/> would otherwise show up in every frame.
  await context.addInitScript(() => {
    try {
      localStorage.setItem('proxion.demoBanner.dismissed', '1');
    } catch {
      // ignore
    }
  });
  const page = await context.newPage();

  // Every step is paced with a short settle so the exported GIF actually reads (a cut that's
  // too fast is worse than a GIF that's a couple of seconds longer) -- see the ticket's
  // ~15-25s target, checked against the final file below.

  // 1. Dashboard, thumbnails visible.
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.getByText(/Consoles \(\d+\)/).waitFor();
  await page.waitForTimeout(2200);

  // 2. Click a VM in the tree.
  await page
    .getByRole('tree', { name: 'Inventory' })
    .getByText('web-prod-01')
    .click();
  await page.getByRole('heading', { name: 'Guest' }).waitFor();
  await page.waitForTimeout(1600);

  // 3. Summary (already there) -> 4. Monitor tab.
  await page.getByRole('tab', { name: 'Monitor' }).click();
  await page.getByRole('heading', { name: 'CPU' }).waitFor();
  await page.waitForTimeout(2200);

  // 5. Back to Summary.
  await page.getByRole('tab', { name: 'Summary' }).click();
  await page.getByRole('heading', { name: 'Guest' }).waitFor();
  await page.waitForTimeout(1400);

  // 6. Header "Shut down" -> 7. confirmation dialog.
  await page.getByRole('button', { name: 'Shut down' }).click();
  await page.getByRole('alertdialog').waitFor();
  await page.getByText('Force stop after timeout').waitFor();
  await page.waitForTimeout(2000);

  // 8. Cancel.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
  await page.waitForTimeout(700);

  // 9. Preferences -> theme switch light -> dark, quick.
  await page.getByRole('link', { name: 'Proxion home' }).waitFor(); // just settling the header
  await page.goto(`${base}/preferences`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Preferences' }).waitFor();
  await page.waitForTimeout(1000);
  const themeGroup = page.getByRole('group', { name: 'Theme' });
  await themeGroup.getByRole('button', { name: 'Light' }).click();
  await page.waitForTimeout(450);
  await themeGroup.getByRole('button', { name: 'Dark' }).click();
  await page.waitForTimeout(900);

  // 10. Back to dashboard.
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: 'Datacenter' })
    .click();
  await page.getByText('Virtual machines').waitFor();
  await page.waitForTimeout(1800);

  await context.close();
  await server.close();
  await browser.close();

  const video = await page.video()?.path();
  if (!video || !fs.existsSync(video)) {
    throw new Error('Playwright did not produce a video file');
  }
  fs.copyFileSync(video, WEBM_PATH);
  console.log(`Recorded ${WEBM_PATH}`);

  const ffmpeg = findFullFfmpeg();
  if (!ffmpeg || !ffmpegSupportsGif(ffmpeg)) {
    console.warn(
      'No ffmpeg build with gif/palettegen/paletteuse found (Playwright\'s own bundled ffmpeg ' +
        "doesn't have them -- see this file's header comment). Leaving the .webm in place; " +
        'set FFMPEG_PATH to a full ffmpeg build to also produce the GIF.',
    );
    fs.rmSync(VIDEO_DIR, { recursive: true, force: true });
    return;
  }

  console.log(`Converting to GIF with ${ffmpeg} (two-pass palette)...`);
  const palettePath = path.join(VIDEO_DIR, 'palette.png');
  const scaleFilter = `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`;
  // `stats_mode=diff` + `max_colors=128` (mostly-static UI, few moving parts) and a light bayer
  // dither keep this well under the README's 4MB budget -- a naive `fps=12,scale=1280,palettegen`
  // pass of this same recording came out around 10MB; this combination lands around 3MB.
  execFileSync(ffmpeg, [
    '-y',
    '-i', WEBM_PATH,
    '-vf', `${scaleFilter},palettegen=stats_mode=diff:max_colors=128`,
    palettePath,
  ]);
  execFileSync(ffmpeg, [
    '-y',
    '-i', WEBM_PATH,
    '-i', palettePath,
    '-filter_complex',
    `${scaleFilter}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
    GIF_PATH,
  ]);
  console.log(`Wrote ${GIF_PATH}`);

  fs.rmSync(VIDEO_DIR, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
