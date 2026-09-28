/**
 * Filename validation shared by `UploadDialog.tsx` and `DownloadUrlDialog.tsx` (T34) -- pure and
 * unit-tested so both dialogs (and any future caller) validate a storage filename identically.
 *
 * Two layers, checked in order:
 *  1. The character rule -- same regex/length/`..`-rejection the server enforces
 *     (`apps/server/src/actions/storageRoutes.ts`'s `filenameSchema`). KEEP THIS IDENTICAL to the
 *     server's own `FILENAME_RE`.
 *  2. The per-content-type extension rule Proxmox VE itself enforces server-side (`PVE::Storage`):
 *     iso -> `\.(iso|img)$`, vztmpl -> `\.tar\.([gx]z|zst)$`, import -> `\.(ova|qcow2|raw|vmdk)$`.
 *     A filename that passes (1) but fails (2) is exactly the production bug this ticket fixes --
 *     "download from URL" with content type ISO and a filename with no extension (e.g. `bookworm`)
 *     reached Proxmox and came back 400 with no useful detail in the toast.
 *
 * This inline validation is a UX nicety only -- the server (`storageRoutes.ts`) is what actually
 * protects itself and enforces the same two rules before ever calling PVE.
 */

export type StorageUploadContent = 'iso' | 'vztmpl' | 'import';

const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,254}$/;

const CHARACTER_RULE_MESSAGE =
  'Filename must start with a letter or digit and contain only letters, digits, `_`, `.`, `+`, `-` (no `..`).';

/** Per-content-type extension patterns PVE enforces server-side. Exported so callers (e.g. a file
 * input's `accept` attribute) can stay in lockstep with the actual rule. */
export const EXTENSION_PATTERNS: Record<StorageUploadContent, RegExp> = {
  iso: /\.(iso|img)$/,
  vztmpl: /\.tar\.([gx]z|zst)$/,
  import: /\.(ova|qcow2|raw|vmdk)$/,
};

const EXTENSION_MESSAGES: Record<StorageUploadContent, string> = {
  iso: 'ISO images must end in .iso or .img',
  vztmpl: 'Container templates must end in .tar.gz, .tar.xz or .tar.zst',
  import: 'Import files must end in .ova, .qcow2, .raw or .vmdk',
};

function isValidCharacters(filename: string): boolean {
  return (
    filename.length > 0 && filename.length <= 255 && FILENAME_RE.test(filename) && !filename.includes('..')
  );
}

/** Validates `filename` for the given storage `content` type. Returns `null` when valid, or the
 * error text to show under the field / send back to the caller otherwise. Checks the character
 * rule first (a filename with bad characters is rejected regardless of extension), then the
 * content type's extension rule. */
export function validateStorageFilename(content: StorageUploadContent, filename: string): string | null {
  if (!isValidCharacters(filename)) return CHARACTER_RULE_MESSAGE;
  if (!EXTENSION_PATTERNS[content].test(filename)) return EXTENSION_MESSAGES[content];
  return null;
}
