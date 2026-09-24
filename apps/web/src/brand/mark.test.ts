import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  MARK_DEFAULT,
  MARK_FAVICON,
  MARK_VIEWBOX,
  hexagonPoints,
  ionPosition,
  markSvg,
} from './mark';

const WEB_ROOT = path.resolve(import.meta.dirname, '../..');

describe('brand mark geometry', () => {
  it('draws a closed regular hexagon centred in the viewbox', () => {
    const pts = hexagonPoints(19)
      .split(' ')
      .map((p): [number, number] => {
        const [x, y] = p.split(',').map(Number);
        return [x ?? NaN, y ?? NaN];
      });
    expect(pts).toHaveLength(6);
    const c = MARK_VIEWBOX / 2;
    for (const [x, y] of pts) {
      expect(Math.hypot(x - c, y - c)).toBeCloseTo(19, 1);
    }
    expect(pts[0]).toEqual([32, 13]); // pointy-top: first vertex straight up
  });

  it('keeps the ion inside the tile with its full radius, at every weight', () => {
    const ion = ionPosition();
    for (const w of [MARK_DEFAULT, MARK_FAVICON]) {
      expect(ion.x - w.ionRadius).toBeGreaterThan(0);
      expect(ion.x + w.ionRadius).toBeLessThan(MARK_VIEWBOX);
      expect(ion.y - w.ionRadius).toBeGreaterThan(0);
      expect(ion.y + w.ionRadius).toBeLessThan(MARK_VIEWBOX);
    }
    // Upper-right quadrant, clear of the hexagon's top-right edge.
    expect(ion.x).toBeGreaterThan(48);
    expect(ion.y).toBeLessThan(24);
  });

  it('renders a standalone SVG with tile, node, orbit and ion', () => {
    const svg = markSvg({ tile: true, size: 64 });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('width="64" height="64"');
    expect(svg).toContain('<rect');
    expect(svg).toContain('<polygon');
    expect(svg).toContain('<ellipse');
    expect(svg).toContain('<circle');
    expect(markSvg()).not.toContain('<rect');
  });
});

describe('shipped icon set', () => {
  it('public/favicon.svg is the current favicon-weight mark (run `pnpm icons` after editing mark.ts)', () => {
    const shipped = fs.readFileSync(path.join(WEB_ROOT, 'public/favicon.svg'), 'utf8').trim();
    expect(shipped).toBe(markSvg({ weights: MARK_FAVICON, tile: true }));
  });

  it('every icon/manifest link in index.html points at a file in public/', () => {
    const html = fs.readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8');
    const hrefs = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)" href="([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(hrefs.length).toBeGreaterThanOrEqual(4);
    for (const href of hrefs) {
      expect(fs.existsSync(path.join(WEB_ROOT, 'public', href.replace(/^\//, '')))).toBe(true);
    }
  });

  it('favicon.ico is a PNG-in-ICO with 16/32/48 entries', () => {
    const ico = fs.readFileSync(path.join(WEB_ROOT, 'public/favicon.ico'));
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(3);
    const sizes = [0, 1, 2].map((i) => ico.readUInt8(6 + i * 16));
    expect(sizes).toEqual([16, 32, 48]);
    const firstOffset = ico.readUInt32LE(6 + 12);
    expect(ico.subarray(firstOffset, firstOffset + 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
});
