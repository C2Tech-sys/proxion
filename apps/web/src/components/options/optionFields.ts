import type { GuestType } from '@/api/types';
import type { HotplugItem } from '@/lib/pve-config';

/** The Options tab rows that open the generic `EditOptionDialog` (Name/Hostname reuses the rename
 * dialog instead, and the lxc Unprivileged/Architecture rows are read-only). */
export type OptionFieldId =
  | 'onboot'
  | 'startup'
  | 'ostype'
  | 'protection'
  | 'tags'
  | 'agent'
  | 'localtime'
  | 'tablet'
  | 'acpi'
  | 'kvm'
  | 'hotplug'
  | 'nameserver'
  | 'searchdomain';

export type OptionFieldKind =
  | 'boolean'
  | 'tristate'
  | 'select'
  | 'startup'
  | 'tags'
  | 'agent'
  | 'hotplug'
  | 'nameservers'
  | 'searchdomain';

export interface OptionFieldDef {
  id: OptionFieldId;
  /** The row label and the dialog's subject. */
  label: string;
  kind: OptionFieldKind;
  /** The PVE config keys the row shows, so a pending change to one of them badges the row. */
  keys: string[];
  /** The privilege each guest type needs to change it (mirrors the server route). */
  privilege: Partial<Record<GuestType, string>>;
  /** Booleans only: what PVE assumes when the key is absent. */
  defaultOn?: boolean;
  /** Booleans only: ask for an explicit confirmation instead of a plain checkbox. */
  confirm?: boolean;
}

export const OPTION_FIELDS: Record<OptionFieldId, OptionFieldDef> = {
  onboot: {
    id: 'onboot',
    label: 'Start at boot',
    kind: 'boolean',
    keys: ['onboot'],
    privilege: { qemu: 'VM.Config.Options', lxc: 'VM.Config.Options' },
    defaultOn: false,
  },
  startup: {
    id: 'startup',
    label: 'Start/Shutdown order',
    kind: 'startup',
    keys: ['startup'],
    privilege: { qemu: 'VM.Config.Options', lxc: 'VM.Config.Options' },
  },
  ostype: {
    id: 'ostype',
    label: 'OS Type',
    kind: 'select',
    keys: ['ostype'],
    privilege: { qemu: 'VM.Config.Options' },
  },
  protection: {
    id: 'protection',
    label: 'Protection',
    kind: 'boolean',
    keys: ['protection'],
    privilege: { qemu: 'VM.Config.Options', lxc: 'VM.Config.Options' },
    defaultOn: false,
    confirm: true,
  },
  tags: {
    id: 'tags',
    label: 'Tags',
    kind: 'tags',
    keys: ['tags'],
    privilege: { qemu: 'VM.Config.Options', lxc: 'VM.Config.Options' },
  },
  agent: {
    id: 'agent',
    label: 'QEMU Guest Agent',
    kind: 'agent',
    keys: ['agent'],
    privilege: { qemu: 'VM.Config.Options' },
  },
  localtime: {
    id: 'localtime',
    label: 'Use local time for RTC',
    kind: 'tristate',
    keys: ['localtime'],
    privilege: { qemu: 'VM.Config.Options' },
  },
  tablet: {
    id: 'tablet',
    label: 'Use tablet for pointer',
    kind: 'boolean',
    keys: ['tablet'],
    privilege: { qemu: 'VM.Config.HWType' },
    defaultOn: true,
  },
  acpi: {
    id: 'acpi',
    label: 'ACPI support',
    kind: 'boolean',
    keys: ['acpi'],
    privilege: { qemu: 'VM.Config.HWType' },
    defaultOn: true,
  },
  kvm: {
    id: 'kvm',
    label: 'KVM hardware virtualization',
    kind: 'boolean',
    keys: ['kvm'],
    privilege: { qemu: 'VM.Config.HWType' },
    defaultOn: true,
  },
  hotplug: {
    id: 'hotplug',
    label: 'Hotplug',
    kind: 'hotplug',
    keys: ['hotplug'],
    privilege: { qemu: 'VM.Config.HWType' },
  },
  nameserver: {
    id: 'nameserver',
    label: 'DNS servers',
    kind: 'nameservers',
    keys: ['nameserver'],
    // pve-container groups hostname and DNS under the Network privilege.
    privilege: { lxc: 'VM.Config.Network' },
  },
  searchdomain: {
    id: 'searchdomain',
    label: 'DNS search domain',
    kind: 'searchdomain',
    keys: ['searchdomain'],
    privilege: { lxc: 'VM.Config.Network' },
  },
};

/** PVE's qemu `ostype` values, with the labels its own Options panel uses. */
export const OSTYPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'l26', label: 'Linux 6.x - 2.6 Kernel' },
  { value: 'l24', label: 'Linux 2.4 Kernel' },
  { value: 'win11', label: 'Microsoft Windows 11/2022/2025' },
  { value: 'win10', label: 'Microsoft Windows 10/2016/2019' },
  { value: 'win8', label: 'Microsoft Windows 8.x/2012/2012r2' },
  { value: 'win7', label: 'Microsoft Windows 7/2008r2' },
  { value: 'w2k8', label: 'Microsoft Windows 2008' },
  { value: 'wvista', label: 'Microsoft Windows Vista' },
  { value: 'w2k3', label: 'Microsoft Windows 2003' },
  { value: 'wxp', label: 'Microsoft Windows XP' },
  { value: 'w2k', label: 'Microsoft Windows 2000' },
  { value: 'solaris', label: 'Solaris Kernel' },
  { value: 'other', label: 'Other' },
];

/** The hotplug categories as PVE's own panel labels them. */
export const HOTPLUG_LABELS: Record<HotplugItem, string> = {
  network: 'Network',
  disk: 'Disk',
  cpu: 'CPU',
  memory: 'Memory',
  usb: 'USB',
  cloudinit: 'Cloudinit',
};

export function osTypeOptionLabel(value: string | undefined): string {
  if (value === undefined) return 'Other (default)';
  return OSTYPE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}
