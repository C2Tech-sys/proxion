/**
 * The VM/CT Summary tab's panel registry (T22 "Re-arrange tiles on Summary"): the ordered set of
 * panels the tab can render, plus pure helpers for turning a user's saved order (whatever shape
 * it happens to be -- unknown ids, duplicates, missing entries) into a valid, complete ordering
 * of *today's* panels. Kept separate from `SummaryTab.tsx` so the reordering logic -- the part
 * with edge cases worth testing on its own -- has no React/query dependencies at all.
 */

/** One panel's identity, label (used for its "Move up"/"Move down" button names and headers) and
 *  how many of the tab's grid columns it spans. Order here is today's default order. */
export interface SummaryPanelDef {
  id: string;
  label: string;
  span: 1 | 2;
}

/** Matches `SummaryTab.tsx`'s panel grid exactly, in its current (pre-T22) order. `notes` is the
 *  only 2-column panel (T11's "Console first, not stacked above Resources" layout note still
 *  applies to the *default* order -- rearranging is opt-in). */
export const SUMMARY_PANELS: SummaryPanelDef[] = [
  { id: 'console', label: 'Console', span: 1 },
  { id: 'guest', label: 'Guest', span: 1 },
  { id: 'hardware', label: 'Hardware', span: 1 },
  { id: 'resources', label: 'Resources', span: 1 },
  { id: 'notes', label: 'Notes', span: 2 },
  { id: 'related', label: 'Related', span: 1 },
  { id: 'snapshots', label: 'Snapshots', span: 1 },
  { id: 'lastBackup', label: 'Last backup', span: 1 },
];

export const DEFAULT_SUMMARY_ORDER: string[] = SUMMARY_PANELS.map((panel) => panel.id);

const VALID_IDS = new Set(DEFAULT_SUMMARY_ORDER);

/**
 * Turns whatever is stored in a user's preferences (`prefs.summaryLayout?.qemu` /
 * `.lxc` -- server-validated as "an array of short strings", but never as "an array of *today's*
 * panel ids", since the server doesn't know the panel registry) into a complete, valid ordering
 * of `SUMMARY_PANELS`: unknown ids (an old id a later release retired, a typo, junk from a
 * hand-edited file) and duplicates are dropped, then any of today's ids missing from the result
 * are appended in default order. `normaliseOrder(undefined)` -- no saved order yet -- returns
 * `DEFAULT_SUMMARY_ORDER` unchanged (nothing to drop, nothing already present to skip).
 */
export function normaliseOrder(saved: unknown): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  if (Array.isArray(saved)) {
    for (const entry of saved) {
      if (typeof entry !== 'string') continue;
      if (!VALID_IDS.has(entry)) continue;
      if (seen.has(entry)) continue;
      seen.add(entry);
      result.push(entry);
    }
  }

  for (const id of DEFAULT_SUMMARY_ORDER) {
    if (!seen.has(id)) result.push(id);
  }

  return result;
}

/**
 * Moves `id` to index `to` in `order`, returning a new array (never mutates `order`). `to` is
 * expressed in the coordinates of `order` *with `id` already removed* -- i.e. "Move up" passes
 * `order.indexOf(id) - 1` and "Move down" passes `order.indexOf(id) + 1`; both read correctly as
 * a single swap with the neighbor in that direction. `to` is clamped to `[0, order.length - 1]`
 * (after removal), and a missing `id` is a no-op (returns a copy of `order`, unchanged).
 */
export function moveId(order: string[], id: string, to: number): string[] {
  const from = order.indexOf(id);
  if (from === -1) return [...order];
  const next = order.filter((existing) => existing !== id);
  const clampedTo = Math.max(0, Math.min(to, next.length));
  next.splice(clampedTo, 0, id);
  return next;
}

/**
 * Reorders `order` by dropping `sourceId` at `position` ("before" or "after") relative to
 * `targetId` -- the shape a native HTML5 drag-and-drop `drop` handler naturally produces (the
 * dragged id, the id of the panel it was dropped on, and which half of that panel the pointer was
 * over). A no-op (returns a copy of `order`) if either id is missing or they're the same panel.
 */
export function reorderByDrop(
  order: string[],
  sourceId: string,
  targetId: string,
  position: 'before' | 'after',
): string[] {
  if (sourceId === targetId) return [...order];
  if (order.indexOf(sourceId) === -1 || order.indexOf(targetId) === -1) return [...order];
  const without = order.filter((existing) => existing !== sourceId);
  const targetIndex = without.indexOf(targetId);
  const insertAt = position === 'after' ? targetIndex + 1 : targetIndex;
  return moveId(order, sourceId, insertAt);
}
