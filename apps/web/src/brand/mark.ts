/**
 * The Proxion mark: one hexagonal node (the cluster/host symbol) with a single charged
 * particle in orbit around it -- "prox" (the node you're close to) + "ion" (the particle).
 *
 * Geometry lives here, once, in a 64x64 unit space, so the in-app <Logo /> (React, themed
 * via currentColor + the accent token) and `scripts/build-icons.ts` (static favicon set
 * rendered with fixed colours) can never drift apart. Everything is plain numbers/strings so
 * the script can run under Node without React.
 */

export const MARK_VIEWBOX = 64;

/** Fixed brand colours for the static assets (favicon, touch icon, README lockup). The in-app
 *  logo uses theme tokens instead; these are the resolved values of the same tokens
 *  (`--zinc-950`, `--zinc-100`, `--accent-teal` in index.css). */
export const BRAND_COLORS = {
  tile: '#09090b',
  node: '#f4f4f5',
  ion: '#00bdbe',
} as const;

const CENTER = MARK_VIEWBOX / 2;

/** Pointy-top regular hexagon centred in the viewbox. */
export function hexagonPoints(radius: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = ((-90 + 60 * i) * Math.PI) / 180;
    const x = CENTER + radius * Math.cos(angle);
    const y = CENTER + radius * Math.sin(angle);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(' ');
}

/** Orbit ellipse: centred, tilted so it cuts through two hexagon edges rather than lining up
 *  with any of them (that's what makes it read as an orbit and not a frame). */
export const ORBIT = { rx: 27, ry: 10, tiltDeg: -25 } as const;

/** Where the ion sits on the orbit (parametric angle in degrees, 0 = +x before tilt).
 *  Upper right so it clears the hexagon's top-right edge instead of overlapping a vertex. */
export const ION_ANGLE_DEG = -20;

export function ionPosition(): { x: number; y: number } {
  const t = (ION_ANGLE_DEG * Math.PI) / 180;
  const tilt = (ORBIT.tiltDeg * Math.PI) / 180;
  const px = ORBIT.rx * Math.cos(t);
  const py = ORBIT.ry * Math.sin(t);
  return {
    x: CENTER + px * Math.cos(tilt) - py * Math.sin(tilt),
    y: CENTER + px * Math.sin(tilt) + py * Math.cos(tilt),
  };
}

export interface MarkWeights {
  hexRadius: number;
  hexStroke: number;
  orbitStroke: number;
  ionRadius: number;
}

/** Default weights, tuned for 20-64px on screen. */
export const MARK_DEFAULT: MarkWeights = {
  hexRadius: 19,
  hexStroke: 4,
  orbitStroke: 2.75,
  ionRadius: 4.5,
};

/** Heavier weights so the same mark survives 16px in a browser tab. */
export const MARK_FAVICON: MarkWeights = {
  hexRadius: 19,
  hexStroke: 5,
  orbitStroke: 3.5,
  ionRadius: 5.5,
};

export interface MarkSvgOptions {
  weights?: MarkWeights;
  /** Paint a rounded tile behind the mark (favicons); omit for a transparent mark. */
  tile?: boolean;
  colors?: { tile?: string; node?: string; ion?: string };
  /** Pixel size for width/height attributes; omitted = scalable. */
  size?: number;
}

/** Standalone SVG document string (for the static assets). */
export function markSvg(options: MarkSvgOptions = {}): string {
  const w = options.weights ?? MARK_DEFAULT;
  const c = { ...BRAND_COLORS, ...options.colors };
  const ion = ionPosition();
  const sizeAttrs =
    options.size !== undefined ? ` width="${options.size}" height="${options.size}"` : '';
  const tile = options.tile
    ? `<rect width="${MARK_VIEWBOX}" height="${MARK_VIEWBOX}" rx="14" fill="${c.tile}"/>`
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}"${sizeAttrs} role="img" aria-label="Proxion">` +
    tile +
    `<polygon points="${hexagonPoints(w.hexRadius)}" fill="none" stroke="${c.node}" stroke-width="${w.hexStroke}" stroke-linejoin="round"/>` +
    `<ellipse cx="${CENTER}" cy="${CENTER}" rx="${ORBIT.rx}" ry="${ORBIT.ry}" transform="rotate(${ORBIT.tiltDeg} ${CENTER} ${CENTER})" fill="none" stroke="${c.ion}" stroke-width="${w.orbitStroke}" stroke-linecap="round"/>` +
    `<circle cx="${ion.x.toFixed(2)}" cy="${ion.y.toFixed(2)}" r="${w.ionRadius}" fill="${c.ion}"/>` +
    `</svg>`
  );
}
