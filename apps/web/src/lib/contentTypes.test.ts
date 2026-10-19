import { describe, expect, it } from 'vitest';

import { CONTENT_TYPE_ORDER, parseContentTypes } from '@/lib/contentTypes';

describe('parseContentTypes', () => {
  it('orders a reversed string canonically', () => {
    expect(parseContentTypes('import,snippets,backup,iso,vztmpl,rootdir,images')).toStrictEqual([
      'images',
      'rootdir',
      'vztmpl',
      'iso',
      'backup',
      'snippets',
      'import',
    ]);
  });

  it('keeps CONTENT_TYPE_ORDER as the canonical list', () => {
    expect([...CONTENT_TYPE_ORDER]).toStrictEqual(['images', 'rootdir', 'vztmpl', 'iso', 'backup', 'snippets', 'import']);
  });

  it('puts unknown types after the known ones, alphabetically', () => {
    expect(parseContentTypes('zeta,backup,alpha,images,mid')).toStrictEqual(['images', 'backup', 'alpha', 'mid', 'zeta']);
  });

  it('returns [] for empty, undefined, null and separator-only input', () => {
    expect(parseContentTypes('')).toStrictEqual([]);
    expect(parseContentTypes(undefined)).toStrictEqual([]);
    expect(parseContentTypes(null)).toStrictEqual([]);
    expect(parseContentTypes(' , ,,')).toStrictEqual([]);
  });

  it('trims whitespace and drops duplicates', () => {
    expect(parseContentTypes(' iso , backup,iso,,backup , vztmpl ')).toStrictEqual(['vztmpl', 'iso', 'backup']);
  });

  it('gives identical output for two different input orders', () => {
    const a = parseContentTypes('backup,snippets,import,iso,vztmpl');
    const b = parseContentTypes('import,vztmpl,iso,snippets,backup');
    expect(a).toStrictEqual(['vztmpl', 'iso', 'backup', 'snippets', 'import']);
    expect(b).toStrictEqual(a);
  });

  it('returns a new array on every call', () => {
    const first = parseContentTypes('iso,backup');
    const second = parseContentTypes('iso,backup');
    expect(first).not.toBe(second);
    first.push('mutated');
    expect(parseContentTypes('iso,backup')).toStrictEqual(['iso', 'backup']);
  });
});
