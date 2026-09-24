import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUMMARY_ORDER,
  SUMMARY_PANELS,
  moveId,
  normaliseOrder,
  reorderByDrop,
} from '@/pages/vm/summaryLayout';

describe('SUMMARY_PANELS / DEFAULT_SUMMARY_ORDER', () => {
  it('matches the panel ids SummaryTab renders, in its current order', () => {
    expect(DEFAULT_SUMMARY_ORDER).toEqual([
      'console',
      'guest',
      'hardware',
      'resources',
      'notes',
      'related',
      'snapshots',
      'lastBackup',
    ]);
  });

  it('notes is the only 2-column panel', () => {
    const twoColumn = SUMMARY_PANELS.filter((p) => p.span === 2).map((p) => p.id);
    expect(twoColumn).toEqual(['notes']);
  });
});

describe('normaliseOrder', () => {
  it('returns the default order unchanged when nothing is saved', () => {
    expect(normaliseOrder(undefined)).toEqual(DEFAULT_SUMMARY_ORDER);
    expect(normaliseOrder(null)).toEqual(DEFAULT_SUMMARY_ORDER);
  });

  it('passes through a full, valid saved order untouched', () => {
    const custom = ['notes', 'console', 'guest', 'hardware', 'resources', 'related', 'snapshots', 'lastBackup'];
    expect(normaliseOrder(custom)).toEqual(custom);
  });

  it('drops unknown ids', () => {
    expect(normaliseOrder(['notes', 'madeUpPanel', 'console'])).toEqual([
      'notes',
      'console',
      'guest',
      'hardware',
      'resources',
      'related',
      'snapshots',
      'lastBackup',
    ]);
  });

  it('drops non-string entries', () => {
    expect(normaliseOrder(['notes', 42, null, {}, 'console'])).toEqual([
      'notes',
      'console',
      'guest',
      'hardware',
      'resources',
      'related',
      'snapshots',
      'lastBackup',
    ]);
  });

  it('drops duplicates, keeping the first occurrence', () => {
    expect(normaliseOrder(['notes', 'notes', 'console'])[0]).toBe('notes');
    expect(normaliseOrder(['notes', 'notes', 'console']).filter((id) => id === 'notes')).toHaveLength(1);
  });

  it('appends ids missing from a partial saved order, in default order', () => {
    expect(normaliseOrder(['lastBackup', 'console'])).toEqual([
      'lastBackup',
      'console',
      'guest',
      'hardware',
      'resources',
      'notes',
      'related',
      'snapshots',
    ]);
  });

  it('ignores a non-array value entirely', () => {
    expect(normaliseOrder('notes,console')).toEqual(DEFAULT_SUMMARY_ORDER);
    expect(normaliseOrder({ qemu: ['notes'] })).toEqual(DEFAULT_SUMMARY_ORDER);
  });
});

describe('moveId', () => {
  const order = ['a', 'b', 'c', 'd'];

  it('moves an id up (to index - 1) by swapping with its previous neighbor', () => {
    expect(moveId(order, 'c', 1)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('moves an id down (to index + 1) by swapping with its next neighbor', () => {
    expect(moveId(order, 'b', 2)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('clamps a negative target to the front', () => {
    expect(moveId(order, 'c', -5)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('clamps an out-of-range target to the back', () => {
    expect(moveId(order, 'a', 99)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('is a no-op (content-equal copy) for an id not present', () => {
    expect(moveId(order, 'z', 0)).toEqual(order);
  });

  it('never mutates its input', () => {
    const before = [...order];
    moveId(order, 'a', 3);
    expect(order).toEqual(before);
  });
});

describe('reorderByDrop', () => {
  const order = ['a', 'b', 'c', 'd'];

  it('drops before the target', () => {
    expect(reorderByDrop(order, 'd', 'b', 'before')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('drops after the target', () => {
    expect(reorderByDrop(order, 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('is a no-op when source and target are the same', () => {
    expect(reorderByDrop(order, 'b', 'b', 'after')).toEqual(order);
  });

  it('is a no-op when either id is unknown', () => {
    expect(reorderByDrop(order, 'z', 'b', 'after')).toEqual(order);
    expect(reorderByDrop(order, 'a', 'z', 'after')).toEqual(order);
  });
});
