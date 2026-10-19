/**
 * PVE's own storage-content order: disk images, container volumes, container templates, ISO images,
 * backups, snippets, import. The cluster-resources `content` string is a comma-joined list whose
 * order PVE does not keep stable between polls (Perl hash order), so anything shown to the user is
 * sorted by this list instead of rendered in the order it arrived.
 */
export const CONTENT_TYPE_ORDER = ['images', 'rootdir', 'vztmpl', 'iso', 'backup', 'snippets', 'import'] as const;

const RANK = new Map<string, number>(CONTENT_TYPE_ORDER.map((type, index) => [type, index]));

/**
 * Splits a PVE `content` string (`"iso,vztmpl,backup"`) into its types: trimmed, empties dropped,
 * de-duplicated, then ordered by `CONTENT_TYPE_ORDER` with any type PVE adds later after the known
 * ones, alphabetically. Pure; always returns a new array, and the result does not depend on the
 * order of the input.
 */
export function parseContentTypes(content: string | undefined | null): string[] {
  const types = new Set<string>();
  for (const part of (content ?? '').split(',')) {
    const type = part.trim();
    if (type !== '') types.add(type);
  }
  return [...types].sort((a, b) => {
    const rankA = RANK.get(a);
    const rankB = RANK.get(b);
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
