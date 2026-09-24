import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for T8's font-switching blocker: `--font-display`/`--font-sans`/`--font-mono`
 * must never be declared inside an `@theme inline { ... }` block in index.css.
 *
 * Tailwind v4's `inline` option makes a utility's generated CSS use the theme value's own text
 * verbatim. For the color tokens (which stay `@theme inline`), that text is already a
 * `var(--x)` reference, so inlining it just drops one level of indirection and utilities like
 * `.bg-background` still resolve at runtime. But a *literal* font stack has nothing to inline:
 * `@theme inline { --font-sans: 'Open Sans Variable', ... }` compiles `body`'s `font-sans` utility
 * to a literal `font-family:` string in the built CSS, permanently -- any runtime override of
 * `--font-display`/`--font-sans`/`--font-mono` (a theme, a user preference, a future pairing) is
 * then silently ignored. This bit us once during the font selection (and again, differently, at
 * T10's font swap). The tokens must instead live in a plain `@theme { ... }` block (see
 * index.css), which keeps the utility as `font-family: var(--font-sans)` so runtime overrides
 * actually apply.
 *
 * This test parses index.css's raw text (brace-matching, not a full CSS parser -- good enough
 * for this file's structure) and fails if any `@theme inline { ... }` block contains a
 * `--font-display`/`--font-sans`/`--font-mono` declaration.
 */
/** Strips `/* ... *\/` comments so a comment merely *mentioning* `@theme inline` (like the ones
 * in this very file, or in index.css's own explanatory notes) can't be mistaken for the real
 * at-rule. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function extractThemeInlineBlocks(css: string): string[] {
  const code = stripComments(css);
  const blocks: string[] = [];
  const marker = '@theme inline';
  let searchFrom = 0;
  for (;;) {
    const markerIndex = code.indexOf(marker, searchFrom);
    if (markerIndex === -1) break;
    const openBrace = code.indexOf('{', markerIndex);
    if (openBrace === -1) break;
    let depth = 1;
    let i = openBrace + 1;
    while (i < code.length && depth > 0) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') depth--;
      i++;
    }
    blocks.push(code.slice(openBrace + 1, i - 1));
    searchFrom = i;
  }
  return blocks;
}

describe('index.css: @theme inline must never declare font tokens', () => {
  it('has no --font-display / --font-sans / --font-mono inside any @theme inline block', () => {
    const cssPath = path.resolve(import.meta.dirname, '../index.css');
    const css = readFileSync(cssPath, 'utf-8');

    const inlineBlocks = extractThemeInlineBlocks(css);
    expect(inlineBlocks.length).toBeGreaterThan(0); // sanity: the file still has one (colors, radius)

    for (const block of inlineBlocks) {
      expect(block).not.toMatch(/--font-display\s*:/);
      expect(block).not.toMatch(/--font-sans\s*:/);
      expect(block).not.toMatch(/--font-mono\s*:/);
    }
  });

  it('declares --font-display / --font-sans / --font-mono in a plain (non-inline) @theme block instead', () => {
    const cssPath = path.resolve(import.meta.dirname, '../index.css');
    const code = stripComments(readFileSync(cssPath, 'utf-8'));

    // A plain `@theme {` not immediately followed by `inline` -- i.e. not `@theme inline {`.
    expect(code).toMatch(/@theme\s*\{[^}]*--font-display\s*:/);
    expect(code).toMatch(/@theme\s*\{[^}]*--font-sans\s*:/);
    expect(code).toMatch(/@theme\s*\{[^}]*--font-mono\s*:/);
  });
});
