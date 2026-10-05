import { useState, type ReactNode } from 'react';
import { Plus, Trash2, Unplug } from 'lucide-react';

import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { EditHardwareButton } from '@/components/hardware/EditHardwareButton';
import { EditCpuDialog } from '@/components/hardware/EditCpuDialog';
import { EditMemoryDialog } from '@/components/hardware/EditMemoryDialog';
import { EditCdromDialog } from '@/components/hardware/EditCdromDialog';
import { ResizeDiskDialog } from '@/components/hardware/ResizeDiskDialog';
import { AddDiskDialog } from '@/components/hardware/AddDiskDialog';
import { DetachDiskDialog } from '@/components/hardware/DetachDiskDialog';
import { RemoveUnusedDiskDialog } from '@/components/hardware/RemoveUnusedDiskDialog';
import { PendingBanner } from '@/components/hardware/PendingBanner';
import { AddNicButton, EditNicDialog } from '@/components/hardware/EditNicDialog';
import { RemoveNicButton, RemoveNicDialog } from '@/components/hardware/RemoveNicDialog';
import { AddDeviceMenu } from '@/components/devices/AddDeviceMenu';
import { AddSerialDialog } from '@/components/devices/AddSerialDialog';
import { EditPciDialog } from '@/components/devices/EditPciDialog';
import { EditUsbDialog } from '@/components/devices/EditUsbDialog';
import { RemoveDeviceDialog } from '@/components/devices/RemoveDeviceDialog';
import { describePci, describeSerial, describeUsb } from '@/components/devices/describe';
import { useAuthMe, useClusterResources, useVmConfig } from '@/api/hooks';
import { diskCapableStorages } from '@/api/disks';
import { usePermissions } from '@/api/actionHooks';
import { usePendingConfig, useResizeDisk } from '@/api/hardwareHooks';
import { isPendingEntry } from '@/api/hardware';
import { USE_FIXTURES } from '@/api/client';
import { errorMessage } from '@/api/errors';
import { formatBytes, formatDriveSize } from '@/lib/format';
import {
  getDrives,
  getNetSpecs,
  getRootfsDrive,
  parseGuestBootOrder,
  parseHostPciConfig,
  parseMemory,
  parseNicConfig,
  parseSerialConfig,
  parseUsbConfig,
  type DeviceKind,
  type NicFields,
  type ParsedDrive,
  type ParsedNetSpec,
  type PciFields,
  type UsbFields,
} from '@/lib/pve-config';
import type { VmTabProps } from '@/pages/vm/tabs';
import type { GuestConfig } from '@/api/types';
import { BootOrderEditButton } from '@/components/hardware/BootOrderDialog';

interface Row {
  label: string;
  value: ReactNode;
  /** The PVE config keys this row shows, so a pending change to one of them can badge the row. */
  keys?: string[];
  /** The row's edit affordance (pencil), when it has one. */
  action?: ReactNode;
}

/** What an open edit dialog is editing. */
type EditTarget =
  | { kind: 'cpu' }
  | { kind: 'memory' }
  | { kind: 'cdrom'; slot: string; volid: string | undefined }
  | { kind: 'disk'; disk: string; size: string | undefined }
  | { kind: 'addDisk' }
  | { kind: 'detach'; slot: string; volume: string }
  | { kind: 'removeUnused'; slot: string; volume: string | undefined };

/** Builds one row's pencil, already gated on session mode and the privilege it needs. */
type ActionFor = (label: string, privilege: string, target: EditTarget) => ReactNode;

/** What an open network-device dialog is for: a new device, one being edited, or one being removed. */
type NicTarget = { kind: 'add' } | { kind: 'edit'; nic: NicFields } | { kind: 'remove'; slot: string };

/** The network section's actions, already gated on session mode and `VM.Config.Network`: the
 * "Add network device" button of its header row, and the edit pencil + remove trash of a NIC row. */
interface NicActions {
  add: () => ReactNode;
  row: (nic: NicFields) => ReactNode;
}

/** What an open device dialog is for (T55): adding one of the three kinds, editing a USB/PCI
 * device, or removing any of them. */
type DeviceTarget =
  | { kind: 'add'; device: DeviceKind }
  | { kind: 'editUsb'; usb: UsbFields }
  | { kind: 'editPci'; pci: PciFields }
  | { kind: 'remove'; slot: string; value: string };

/** The Devices section's actions, already gated on session mode and `VM.Config.HWType`: the
 * "Add device" menu of its header row, and the edit pencil (not for serial) + remove trash of a
 * device row. */
interface DeviceActions {
  add: () => ReactNode;
  row: (kind: DeviceKind, slot: string, raw: string) => ReactNode;
}

/** `usb0`, `usb10`, ... sorted by their number. */
function sortedSlots(keys: string[]): string[] {
  const n = (key: string) => Number(key.replace(/^\D+/, ''));
  return [...keys].sort((a, b) => n(a) - n(b));
}

function Flag({ on }: { on: boolean | undefined }) {
  if (on === undefined) return <span className="text-muted-foreground">-</span>;
  return <Badge variant={on ? 'default' : 'secondary'}>{on ? 'On' : 'Off'}</Badge>;
}

function driveLine(drive: ParsedDrive): ReactNode {
  // Identifier, not a monospace target (T11): plain sans, same as every other identifier.
  return (
    <span data-testid="volume-id">
      {drive.storage}:{drive.volume}
      {drive.size ? (
        // Formatted like every other byte count in the UI (formatBytes, via formatDriveSize --
        // same helper the Summary tab's disk list uses), instead of PVE's raw config-file
        // suffix (`32G`); the raw string stays available as a tooltip.
        <span title={drive.size}>, {formatDriveSize(drive.size)}</span>
      ) : (
        ''
      )}
    </span>
  );
}

/** The volume a CD/DVD drive currently holds (`local:iso/foo.iso`), `undefined` for an empty
 * drive (PVE stores that as `none,media=cdrom`). */
function cdromVolid(drive: ParsedDrive): string | undefined {
  if (drive.storage === 'none' || drive.storage === '' || drive.volume === '') return undefined;
  return `${drive.storage}:${drive.volume}`;
}

function cdromLine(drive: ParsedDrive): ReactNode {
  if (cdromVolid(drive) === undefined) {
    return (
      <span data-testid="volume-id" className="text-muted-foreground">
        No media
      </span>
    );
  }
  return driveLine(drive);
}

function flagPair(label: string, on: boolean | undefined): ReactNode {
  if (on === undefined) return null;
  return (
    <span key={label} className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      {label}
      <Flag on={on} />
    </span>
  );
}

function diskFlags(drive: ParsedDrive): ReactNode {
  const flags = [
    drive.cache && <Badge key="cache" variant="outline">cache={drive.cache}</Badge>,
    flagPair('discard', drive.discard),
    flagPair('ssd', drive.ssd),
    flagPair('iothread', drive.iothread),
  ].filter(Boolean);
  if (flags.length === 0) return null;
  return <div className="flex flex-wrap items-center gap-2.5">{flags}</div>;
}

function netLine(net: ParsedNetSpec): string {
  const bits = [net.model ?? net.type ?? 'net', net.mac ?? net.hwaddr ?? ''].filter(Boolean);
  return bits.join(' ');
}

/** The network section header row's value. */
function nicCount(count: number): ReactNode {
  return <span className="text-muted-foreground">{count === 0 ? 'None' : `${count} device${count === 1 ? '' : 's'}`}</span>;
}

/** A disk bus whose drives the resize route can grow (not `unused`, EFI disk or TPM state). */
function isResizable(drive: ParsedDrive): boolean {
  return ['ide', 'sata', 'scsi', 'virtio', 'mp'].includes(drive.bus) || drive.key === 'rootfs';
}

/** The lowest free `unused[n]` key, i.e. where PVE parks the next detached volume. */
function nextUnusedSlot(config: GuestConfig): string {
  for (let n = 0; n < 256; n++) {
    if (!(`unused${n}` in config)) return `unused${n}`;
  }
  return 'unused0';
}

/** The disk lifecycle buttons (add / detach / remove an unused volume): the same gating and
 * disabled-tooltip convention as `EditHardwareButton`, with their own look. */
function DiskActionButton({
  kind,
  label,
  disabledReason,
  onClick,
}: {
  kind: 'addDisk' | 'detach' | 'removeUnused';
  label: string;
  disabledReason: string | undefined;
  onClick: () => void;
}) {
  const disabled = disabledReason !== undefined;
  if (kind === 'addDisk') {
    return (
      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0"
        aria-label={label}
        disabled={disabled}
        aria-disabled={disabled || undefined}
        title={disabledReason}
        onClick={onClick}
      >
        <Plus className="size-3.5" />
        {label}
      </Button>
    );
  }
  const Icon = kind === 'detach' ? Unplug : Trash2;
  const className = kind === 'removeUnused' ? 'size-7 shrink-0 text-destructive hover:text-destructive' : 'size-7 shrink-0';
  if (disabled) {
    return (
      <Button variant="ghost" size="icon" className={className} disabled aria-disabled="true" aria-label={label} title={disabledReason}>
        <Icon className="size-3.5" />
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className={className} aria-label={label} onClick={onClick}>
          <Icon className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** The disks section's header row: its "Add" button lives in the row's action slot. */
function disksHeaderRow(actionFor: ActionFor, label: string, hint: string): Row {
  return {
    label: 'Disks',
    value: <span className="text-xs text-muted-foreground">{hint}</span>,
    action: actionFor(label, 'VM.Config.Disk', { kind: 'addDisk' }),
  };
}

/** A hard disk's row actions: grow (pencil) and detach. */
function diskActions(resize: ReactNode, detach: ReactNode): ReactNode {
  return (
    <div className="flex shrink-0 items-center">
      {resize}
      {detach}
    </div>
  );
}

function qemuRows(
  config: GuestConfig,
  actionFor: ActionFor,
  guest: { node: string; type: 'qemu' | 'lxc'; vmid: number },
  nicActions: NicActions,
  deviceActions: DeviceActions,
): Row[] {
  const drives = getDrives(config);
  const disks = drives.filter((d) => d.media !== 'cdrom' && d.bus !== 'efidisk' && d.bus !== 'tpmstate' && d.bus !== 'unused' && !d.volume.includes('cloudinit'));
  const unusedDisks = drives.filter((d) => d.bus === 'unused');
  const cdroms = drives.filter((d) => d.media === 'cdrom' && !d.volume.includes('cloudinit'));
  const cloudInit = drives.find((d) => d.volume.includes('cloudinit'));
  const efidisk = drives.find((d) => d.bus === 'efidisk');
  const tpm = drives.find((d) => d.bus === 'tpmstate');
  const nets = getNetSpecs(config);
  const memoryBytes = parseMemory(config.memory);
  const { order: bootOrder, legacy: bootLegacy } = parseGuestBootOrder(config);
  const serialKeys = Object.keys(config).filter((k) => /^serial\d+$/.test(k));
  const usbKeys = Object.keys(config).filter((k) => /^usb\d+$/.test(k));
  const pciKeys = Object.keys(config).filter((k) => /^hostpci\d+$/.test(k));

  const rows: Row[] = [
    {
      label: 'Memory',
      value: memoryBytes !== null ? formatBytes(memoryBytes) : '-',
      keys: ['memory', 'balloon', 'shares'],
      action: actionFor('memory', 'VM.Config.Memory', { kind: 'memory' }),
    },
    {
      label: 'Processors',
      value: `${config.sockets ?? 1} socket(s) × ${config.cores ?? 1} core(s)${config.cpu ? ` (${config.cpu})` : ''}${config.numa ? ', NUMA' : ''}`,
      keys: ['cores', 'sockets', 'cpu', 'vcpus', 'numa'],
      action: actionFor('processors', 'VM.Config.CPU', { kind: 'cpu' }),
    },
    {
      label: 'BIOS',
      value: config.bios === 'ovmf' ? 'OVMF (UEFI)' : (config.bios ?? 'SeaBIOS (default)'),
      keys: ['bios'],
    },
    { label: 'Display', value: config.vga ?? 'default', keys: ['vga'] },
    { label: 'Machine', value: config.machine ?? 'default (i440fx)', keys: ['machine'] },
    { label: 'SCSI Controller', value: config.scsihw ?? 'default (LSI 53C895A)', keys: ['scsihw'] },
  ];

  if (efidisk) rows.push({ label: 'EFI Disk', value: driveLine(efidisk), keys: [efidisk.key] });
  if (tpm) rows.push({ label: 'TPM State', value: driveLine(tpm), keys: [tpm.key] });

  rows.push(disksHeaderRow(actionFor, 'Add disk', 'Hard disks and unused volumes'));

  for (const disk of disks) {
    rows.push({
      label: `Hard Disk (${disk.key})`,
      value: (
        <div className="flex flex-col gap-1">
          {driveLine(disk)}
          {diskFlags(disk)}
        </div>
      ),
      keys: [disk.key],
      action: diskActions(
        isResizable(disk)
          ? actionFor(`disk ${disk.key}`, 'VM.Config.Disk', { kind: 'disk', disk: disk.key, size: disk.size })
          : null,
        actionFor(`Detach ${disk.key}`, 'VM.Config.Disk', { kind: 'detach', slot: disk.key, volume: disk.volume }),
      ),
    });
  }

  for (const unused of unusedDisks) {
    rows.push({
      label: `Unused Disk (${unused.key})`,
      value: driveLine(unused),
      keys: [unused.key],
      action: actionFor(`Remove ${unused.key}`, 'VM.Config.Disk', {
        kind: 'removeUnused',
        slot: unused.key,
        volume: `${unused.storage}:${unused.volume}`,
      }),
    });
  }

  rows.push({ label: 'Network Devices', value: nicCount(nets.length), action: nicActions.add() });
  for (const net of nets) {
    rows.push({
      label: `Network Device (${net.key})`,
      value: (
        <span data-testid="hardware-mac">
          {netLine(net)} @ {net.bridge ?? '-'}
          {net.tag !== undefined ? ` (VLAN ${net.tag})` : ''}
          {net.rate ? `, rate=${net.rate}` : ''}
          {net.firewall ? ', firewall' : ''}
        </span>
      ),
      keys: [net.key],
      action: nicActions.row(parseNicConfig('qemu', net.key, String(config[net.key] ?? ''))),
    });
  }

  for (const cdrom of cdroms) {
    rows.push({
      label: `CD/DVD Drive (${cdrom.key})`,
      value: cdromLine(cdrom),
      keys: [cdrom.key],
      action: actionFor(`CD/DVD drive ${cdrom.key}`, 'VM.Config.CDROM', {
        kind: 'cdrom',
        slot: cdrom.key,
        volid: cdromVolid(cdrom),
      }),
    });
  }

  rows.push({
    label: 'Devices',
    value: <span className="text-xs text-muted-foreground">Serial ports, USB and PCI devices</span>,
    action: deviceActions.add(),
  });
  for (const key of sortedSlots(serialKeys)) {
    const raw = String(config[key]);
    rows.push({
      label: `Serial Port (${key})`,
      value: <span title={raw}>{describeSerial(parseSerialConfig(key, raw))}</span>,
      keys: [key],
      action: deviceActions.row('serial', key, raw),
    });
  }
  for (const key of sortedSlots(usbKeys)) {
    const raw = String(config[key]);
    rows.push({
      label: `USB Device (${key})`,
      value: <span title={raw}>{describeUsb(parseUsbConfig(key, raw), raw)}</span>,
      keys: [key],
      action: deviceActions.row('usb', key, raw),
    });
  }
  for (const key of sortedSlots(pciKeys)) {
    const raw = String(config[key]);
    rows.push({
      label: `PCI Device (${key})`,
      value: <span title={raw}>{describePci(parseHostPciConfig(key, raw), raw)}</span>,
      keys: [key],
      action: deviceActions.row('pci', key, raw),
    });
  }
  if (cloudInit) rows.push({ label: 'CloudInit Drive', value: driveLine(cloudInit), keys: [cloudInit.key] });

  rows.push({
    label: 'Boot Order',
    value:
      bootOrder.length > 0 ? (
        <ol className="flex flex-wrap items-center gap-1.5" data-testid="boot-order-chips">
          {bootOrder.map((device, i) => (
            <li key={device}>
              <Badge variant="outline">
                {i + 1}. {device}
              </Badge>
            </li>
          ))}
          {bootLegacy && (
            <li className="text-xs text-muted-foreground" title="PVE's legacy boot setting">
              (legacy)
            </li>
          )}
        </ol>
      ) : (
        <span className="text-muted-foreground">Default order (disks, then CD/DVD, then network)</span>
      ),
    keys: ['boot'],
    action: <BootOrderEditButton node={guest.node} type={guest.type} vmid={guest.vmid} config={config} />,
  });
  const agentEnabled = config.agent === 1 || String(config.agent ?? '').startsWith('1');
  rows.push({ label: 'QEMU Agent', value: <Flag on={agentEnabled} />, keys: ['agent'] });

  return rows;
}

function lxcRows(config: GuestConfig, actionFor: ActionFor, nicActions: NicActions): Row[] {
  const rootfs = getRootfsDrive(config);
  const mounts = getDrives(config).filter((d) => d.bus === 'mp');
  const unusedDisks = getDrives(config).filter((d) => d.bus === 'unused');
  const nets = getNetSpecs(config);
  const memoryBytes = parseMemory(config.memory);
  const swapBytes = parseMemory(config.swap);

  const rows: Row[] = [
    {
      label: 'Memory',
      value: memoryBytes !== null ? formatBytes(memoryBytes) : '-',
      keys: ['memory'],
      action: actionFor('memory', 'VM.Config.Memory', { kind: 'memory' }),
    },
    {
      label: 'Swap',
      value: swapBytes !== null ? formatBytes(swapBytes) : '-',
      keys: ['swap'],
      action: actionFor('swap', 'VM.Config.Memory', { kind: 'memory' }),
    },
    {
      label: 'Cores',
      value: config.cores ?? '-',
      keys: ['cores'],
      action: actionFor('cores', 'VM.Config.CPU', { kind: 'cpu' }),
    },
    { label: 'Unprivileged', value: <Flag on={config.unprivileged === 1} />, keys: ['unprivileged'] },
    { label: 'Features', value: config.features ?? '-', keys: ['features'] },
  ];

  rows.push(disksHeaderRow(actionFor, 'Add mount point', 'Root disk, mount points and unused volumes'));

  if (rootfs) {
    rows.push({
      label: 'Root Disk (rootfs)',
      value: (
        <div className="flex flex-col gap-1">
          {driveLine(rootfs)}
          {diskFlags(rootfs)}
        </div>
      ),
      keys: ['rootfs'],
      action: actionFor('disk rootfs', 'VM.Config.Disk', { kind: 'disk', disk: 'rootfs', size: rootfs.size }),
    });
  }

  for (const mp of mounts) {
    rows.push({
      label: `Mount Point (${mp.key})`,
      value: (
        <span>
          {driveLine(mp)}
          {mp.options.mp ? ` → ${mp.options.mp}` : ''}
        </span>
      ),
      keys: [mp.key],
      action: diskActions(
        actionFor(`disk ${mp.key}`, 'VM.Config.Disk', { kind: 'disk', disk: mp.key, size: mp.size }),
        actionFor(`Detach ${mp.key}`, 'VM.Config.Disk', { kind: 'detach', slot: mp.key, volume: mp.volume || mp.storage }),
      ),
    });
  }

  for (const unused of unusedDisks) {
    rows.push({
      label: `Unused Disk (${unused.key})`,
      value: driveLine(unused),
      keys: [unused.key],
      action: actionFor(`Remove ${unused.key}`, 'VM.Config.Disk', {
        kind: 'removeUnused',
        slot: unused.key,
        volume: `${unused.storage}:${unused.volume}`,
      }),
    });
  }

  rows.push({ label: 'Network Devices', value: nicCount(nets.length), action: nicActions.add() });
  for (const net of nets) {
    rows.push({
      label: `Network Device (${net.key})`,
      value: (
        <span data-testid="hardware-mac">
          {net.name ?? net.key} @ {net.bridge ?? '-'}
          {net.ip ? `, ip=${net.ip}` : ''}
          {net.gw ? `, gw=${net.gw}` : ''}
          {net.hwaddr ? `, hwaddr=${net.hwaddr}` : ''}
        </span>
      ),
      keys: [net.key],
      action: nicActions.row(parseNicConfig('lxc', net.key, String(config[net.key] ?? ''))),
    });
  }

  return rows;
}

/** A config `memory`/`swap` value in MiB (PVE stores a plain integer), `undefined` when it isn't
 * one (e.g. a qemu `current=...` property string) so the dialog starts blank instead of wrong. */
function toMiB(raw: string | number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = typeof raw === 'number' ? raw : /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The Hardware tab, modelled on PVE's own Hardware panel. Derived entirely from `useVmConfig`;
 * in a session (not service-token) sign-in, rows the caller may change carry a pencil: CPU,
 * memory (+ balloon / swap), each CD/DVD drive's media and each disk's size (grow only). Every
 * pencil is gated on session mode and the PVE privilege that edit needs; the server enforces
 * both independently. While PVE holds changes back until the guest restarts, a banner lists them
 * and the affected rows are badged "pending".
 */
export function HardwareTab({ node, type, vmid }: VmTabProps) {
  const { data: config, isLoading, isError, error } = useVmConfig(node, type, vmid);
  const auth = useAuthMe();
  const permissions = usePermissions(vmid);
  const pending = usePendingConfig(node, type, vmid);
  const clusterResources = useClusterResources();
  // Owned here, not by the resize dialog: the dialog unmounts as soon as a resize succeeds, and
  // the hook's delayed re-reads of the config must outlive it.
  const resize = useResizeDisk();
  const resetResize = resize.reset;
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [nicTarget, setNicTarget] = useState<NicTarget | null>(null);
  const [deviceTarget, setDeviceTarget] = useState<DeviceTarget | null>(null);

  // Fixture/demo mode has no real session concept -- it always demonstrates the enabled state,
  // same as the object header's own quick actions.
  const isSessionMode = USE_FIXTURES || auth.data?.mode === 'session';

  const actionFor: ActionFor = (label, privilege, target) => {
    const disabledReason = !isSessionMode
      ? 'Read-only: signed in with a service token'
      : permissions.data?.can(privilege) !== true
        ? `You don't have ${privilege} on this guest`
        : target.kind === 'addDisk' &&
            clusterResources.data !== undefined &&
            diskCapableStorages(clusterResources.data, node, type).length === 0
          ? `No storage on this node can hold ${type === 'qemu' ? 'disk images' : 'container volumes'}`
          : undefined;
    if (target.kind === 'addDisk' || target.kind === 'detach' || target.kind === 'removeUnused') {
      return (
        <DiskActionButton
          kind={target.kind}
          label={label}
          disabledReason={disabledReason}
          onClick={() => setEditing(target)}
        />
      );
    }
    const open = () => {
      if (target.kind === 'disk') resetResize();
      setEditing(target);
    };
    return <EditHardwareButton label={label} disabledReason={disabledReason} onClick={open} />;
  };

  // Network devices: one privilege for add, edit and remove alike.
  const nicDisabledReason = !isSessionMode
    ? 'Read-only: signed in with a service token'
    : permissions.data?.can('VM.Config.Network') !== true
      ? "You don't have VM.Config.Network on this guest"
      : undefined;
  const nicActions: NicActions = {
    add: () => <AddNicButton disabledReason={nicDisabledReason} onClick={() => setNicTarget({ kind: 'add' })} />,
    row: (nic) => (
      <div className="flex shrink-0 items-center">
        <EditHardwareButton
          label={`network device ${nic.key}`}
          disabledReason={nicDisabledReason}
          onClick={() => setNicTarget({ kind: 'edit', nic })}
        />
        <RemoveNicButton
          slot={nic.key}
          disabledReason={nicDisabledReason}
          onClick={() => setNicTarget({ kind: 'remove', slot: nic.key })}
        />
      </div>
    ),
  };

  // USB, PCI and serial devices (qemu only): one privilege for add, edit and remove alike.
  const deviceDisabledReason = !isSessionMode
    ? 'Read-only: signed in with a service token'
    : permissions.data?.can('VM.Config.HWType') !== true
      ? "You don't have VM.Config.HWType on this guest"
      : undefined;
  const deviceActions: DeviceActions = {
    add: () => (
      <AddDeviceMenu disabledReason={deviceDisabledReason} onPick={(device) => setDeviceTarget({ kind: 'add', device })} />
    ),
    row: (kind, slot, raw) => (
      <div className="flex shrink-0 items-center">
        {kind === 'usb' && (
          <EditHardwareButton
            label={`USB device ${slot}`}
            disabledReason={deviceDisabledReason}
            onClick={() => setDeviceTarget({ kind: 'editUsb', usb: parseUsbConfig(slot, raw) })}
          />
        )}
        {kind === 'pci' && (
          <EditHardwareButton
            label={`PCI device ${slot}`}
            disabledReason={deviceDisabledReason}
            onClick={() => setDeviceTarget({ kind: 'editPci', pci: parseHostPciConfig(slot, raw) })}
          />
        )}
        <RemoveNicButton
          slot={slot}
          disabledReason={deviceDisabledReason}
          onClick={() => setDeviceTarget({ kind: 'remove', slot, value: raw })}
        />
      </div>
    ),
  };

  if (isLoading) {
    return <Skeleton className="h-64" />;
  }
  if (isError) {
    return <EmptyState message={`Could not load configuration: ${errorMessage(error)}`} />;
  }
  if (!config) {
    return <EmptyState message="No configuration available." />;
  }

  const rows =
    type === 'qemu'
      ? qemuRows(config, actionFor, { node, type, vmid }, nicActions, deviceActions)
      : lxcRows(config, actionFor, nicActions);
  const pendingKeys = (pending.data ?? []).filter(isPendingEntry).map((entry) => entry.key);
  const closeDialog = (open: boolean) => {
    if (!open) setEditing(null);
  };
  const closeNicDialog = (open: boolean) => {
    if (!open) setNicTarget(null);
  };
  const closeDeviceDialog = (open: boolean) => {
    if (!open) setDeviceTarget(null);
  };

  return (
    <div>
      <PendingBanner keys={pendingKeys} />
      <div className="rounded-lg border border-border">
        <Table>
          <TableBody>
            {rows.map((row, i) => {
              const isPending = row.keys?.some((k) => pendingKeys.includes(k)) ?? false;
              return (
                <TableRow key={`${row.label}-${i}`}>
                  <TableCell className="w-56 shrink-0 align-top text-muted-foreground">{row.label}</TableCell>
                  <TableCell className="align-top">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <div className="min-w-0">{row.value}</div>
                        {isPending && (
                          <Badge variant="outline" data-testid="hardware-pending-badge">
                            pending
                          </Badge>
                        )}
                      </div>
                      {row.action}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {editing?.kind === 'cpu' && (
        <EditCpuDialog
          open
          onOpenChange={closeDialog}
          node={node}
          type={type}
          vmid={vmid}
          sockets={config.sockets}
          cores={config.cores}
          cpu={config.cpu}
        />
      )}
      {editing?.kind === 'memory' && (
        <EditMemoryDialog
          open
          onOpenChange={closeDialog}
          node={node}
          type={type}
          vmid={vmid}
          memory={toMiB(config.memory)}
          balloon={config.balloon}
          swap={config.swap}
        />
      )}
      {editing?.kind === 'cdrom' && (
        <EditCdromDialog
          open
          onOpenChange={closeDialog}
          node={node}
          type={type}
          vmid={vmid}
          slot={editing.slot}
          currentVolid={editing.volid}
        />
      )}
      {editing?.kind === 'disk' && (
        <ResizeDiskDialog
          open
          onOpenChange={closeDialog}
          node={node}
          type={type}
          vmid={vmid}
          disk={editing.disk}
          size={editing.size}
          mutation={resize}
        />
      )}
      {editing?.kind === 'addDisk' && (
        <AddDiskDialog
          open
          onOpenChange={closeDialog}
          node={node}
          type={type}
          vmid={vmid}
          configKeys={Object.keys(config)}
        />
      )}
      {editing?.kind === 'detach' && (
        <DetachDiskDialog
          open
          onOpenChange={closeDialog}
          node={node}
          type={type}
          vmid={vmid}
          slot={editing.slot}
          volume={editing.volume}
          nextUnusedSlot={nextUnusedSlot(config)}
        />
      )}
      {editing?.kind === 'removeUnused' && (
        <RemoveUnusedDiskDialog
          open
          onOpenChange={closeDialog}
          node={node}
          type={type}
          vmid={vmid}
          slot={editing.slot}
          volume={editing.volume}
        />
      )}
      {nicTarget?.kind === 'add' && (
        <EditNicDialog open onOpenChange={closeNicDialog} node={node} type={type} vmid={vmid} />
      )}
      {nicTarget?.kind === 'edit' && (
        <EditNicDialog open onOpenChange={closeNicDialog} node={node} type={type} vmid={vmid} nic={nicTarget.nic} />
      )}
      {nicTarget?.kind === 'remove' && (
        <RemoveNicDialog
          open
          onOpenChange={closeNicDialog}
          node={node}
          type={type}
          vmid={vmid}
          slot={nicTarget.slot}
        />
      )}
      {deviceTarget?.kind === 'add' && deviceTarget.device === 'usb' && (
        <EditUsbDialog open onOpenChange={closeDeviceDialog} node={node} vmid={vmid} />
      )}
      {deviceTarget?.kind === 'add' && deviceTarget.device === 'pci' && (
        <EditPciDialog open onOpenChange={closeDeviceDialog} node={node} vmid={vmid} />
      )}
      {deviceTarget?.kind === 'add' && deviceTarget.device === 'serial' && (
        <AddSerialDialog open onOpenChange={closeDeviceDialog} node={node} vmid={vmid} />
      )}
      {deviceTarget?.kind === 'editUsb' && (
        <EditUsbDialog open onOpenChange={closeDeviceDialog} node={node} vmid={vmid} device={deviceTarget.usb} />
      )}
      {deviceTarget?.kind === 'editPci' && (
        <EditPciDialog open onOpenChange={closeDeviceDialog} node={node} vmid={vmid} device={deviceTarget.pci} />
      )}
      {deviceTarget?.kind === 'remove' && (
        <RemoveDeviceDialog
          open
          onOpenChange={closeDeviceDialog}
          node={node}
          vmid={vmid}
          slot={deviceTarget.slot}
          value={deviceTarget.value}
        />
      )}
    </div>
  );
}
