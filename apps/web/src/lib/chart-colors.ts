/**
 * Chart series colors -- defined once here so every Monitor-tab panel (and the Summary tab's
 * sparklines) stays consistent: one accent per "primary" line and one muted secondary per
 * panel, with a few semantic pairs (in/out, read/write) that repeat across panels rather than
 * inventing a new color per chart. Actual values live as CSS custom properties in index.css so
 * they follow the theme; canvas (uPlot) cannot resolve `var(--x)` itself, so `resolveChartColor`
 * reads the *computed* value at render time.
 */
export type ChartColorToken = 'teal' | 'violet' | 'emerald' | 'amber' | 'sky' | 'rose';

/** Token -> CSS custom property name (see the "Chart series colors" block in index.css). */
const CHART_COLOR_VAR: Record<ChartColorToken, string> = {
  teal: '--chart-teal',
  violet: '--chart-violet',
  emerald: '--chart-emerald',
  amber: '--chart-amber',
  sky: '--chart-sky',
  rose: '--chart-rose',
};

/** Fallbacks matching index.css's light-theme values, used when computed styles are empty (SSR/tests). */
const CHART_COLOR_FALLBACK: Record<ChartColorToken, string> = {
  teal: '#2fb8ac',
  violet: '#9d7bf0',
  emerald: '#3fb87f',
  amber: '#d99a2b',
  sky: '#5b9bd1',
  rose: '#d16b7a',
};

/** Stable order used to assign colors to series that don't specify one explicitly. */
export const DEFAULT_CHART_COLOR_ORDER: ChartColorToken[] = [
  'teal',
  'violet',
  'emerald',
  'amber',
  'sky',
  'rose',
];

/** Reads a CSS custom property's computed value off `el` (default: the document root). */
export function resolveCssVar(varName: string, el?: Element, fallback = ''): string {
  try {
    const target = el ?? document.documentElement;
    const value = getComputedStyle(target).getPropertyValue(varName).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

/** Resolves a chart color token to a literal CSS color string, suitable for a canvas strokeStyle. */
export function resolveChartColor(token: ChartColorToken, el?: Element): string {
  return resolveCssVar(CHART_COLOR_VAR[token], el, CHART_COLOR_FALLBACK[token]);
}
