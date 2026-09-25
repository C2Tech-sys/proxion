/** PVE's snapshot-name rule: starts with a letter, then letters/digits/underscores/hyphens,
 * 2-40 characters total. */
export const MIN_SNAPSHOT_NAME_LENGTH = 2;
export const MAX_SNAPSHOT_NAME_LENGTH = 40;

const SNAPSHOT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/;

/**
 * PVE's snapshot-name rule, plus the `current` reservation: `current` is PVE's own sentinel for
 * the live-state row every `GET .../snapshot` response includes, and is never a valid name to
 * create, delete or roll back to.
 *
 * KEEP THIS IDENTICAL to `isValidSnapshotName` in `apps/server/src/actions/snapshotRoutes.ts` --
 * that's the same rule, enforced server-side, which is what actually protects PVE. This copy
 * exists purely so `SnapshotCreateDialog` can validate inline, before a request is ever sent; it
 * is a UX nicety, never the source of truth (mirrors the `isValidDnsName`/`guestName.ts` pair).
 */
export function isValidSnapshotName(value: string): boolean {
  return value !== 'current' && SNAPSHOT_NAME_RE.test(value);
}
