import { describe, expect, it } from 'vitest';

import { isValidSnapshotName } from '@/lib/snapshotName';

describe('isValidSnapshotName', () => {
  const cases: Array<[string, boolean]> = [
    ['current', false],
    ['1abc', false],
    ['a', false],
    ['a'.repeat(41), false],
    ['bad name', false],
    ['bad.name', false],
    ['', false],
    ['ab', true],
    ['pre-upgrade_2', true],
    ['a'.repeat(40), true],
    ['Z9', true],
  ];

  for (const [name, valid] of cases) {
    it(`${valid ? 'accepts' : 'rejects'} ${JSON.stringify(name.length > 20 ? `${name.slice(0, 10)}...(${name.length})` : name)}`, () => {
      expect(isValidSnapshotName(name)).toBe(valid);
    });
  }
});
