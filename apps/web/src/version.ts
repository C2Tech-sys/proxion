// Set at build time by vite.config.ts's `define` (from apps/web/package.json's own version,
// which is kept in lockstep with every other workspace package -- see CONTRIBUTING.md's
// "Releasing" section). Falls back to 'dev' for any context that never ran through that define
// (e.g. a test runner with its own Vite config) rather than crashing on a missing global.
declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' && __APP_VERSION__.length > 0 ? __APP_VERSION__ : 'dev';
