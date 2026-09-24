/** PVE's max length for qemu's `name` field / lxc's `hostname` field -- both are validated as a
 * dns-name (see `isValidDnsName`), but the two have different total-length caps. */
export const MAX_VM_NAME_LENGTH = 253;
export const MAX_HOSTNAME_LENGTH = 255;

/** One label of a dns-name: `[A-Za-z0-9]`, optionally with inner `-` (never leading/trailing),
 * 1-63 characters. */
const DNS_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * PVE's `dns-name` format, used for qemu's `name` and lxc's `hostname`: one or more
 * dot-separated labels (see `DNS_LABEL_RE`), the whole string capped at `maxTotalLength`
 * (`MAX_VM_NAME_LENGTH` for qemu, `MAX_HOSTNAME_LENGTH` for lxc).
 *
 * KEEP THIS IDENTICAL to `isValidDnsName` in `apps/server/src/actions/routes.ts` -- that's the
 * same rule, enforced server-side, which is what actually protects PVE. This copy exists purely
 * so `RenameGuestDialog` can validate inline, before a request is ever sent; it is a UX nicety,
 * never the source of truth.
 */
export function isValidDnsName(value: string, maxTotalLength: number): boolean {
  if (value.length === 0 || value.length > maxTotalLength) return false;
  return value.split('.').every((label) => DNS_LABEL_RE.test(label));
}

/** The length cap for a guest's rename field, by guest type: qemu's `name` vs lxc's `hostname`. */
export function maxNameLength(type: 'qemu' | 'lxc'): number {
  return type === 'lxc' ? MAX_HOSTNAME_LENGTH : MAX_VM_NAME_LENGTH;
}

/** `isValidDnsName`, applied to the right length cap for `type`. */
export function isValidGuestName(value: string, type: 'qemu' | 'lxc'): boolean {
  return isValidDnsName(value, maxNameLength(type));
}
