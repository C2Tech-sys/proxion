import type { ReactNode } from 'react';

import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { useVmConfig } from '@/api/hooks';
import { errorMessage } from '@/api/errors';
import { formatBytes } from '@/lib/format';
import {
  getDrives,
  getNetSpecs,
  getRootfsDrive,
  parseBootOrder,
  parseMemory,
  type ParsedDrive,
  type ParsedNetSpec,
} from '@/lib/pve-config';
import type { VmTabProps } from '@/pages/vm/tabs';
import type { GuestConfig } from '@/api/types';

interface Row {
  label: string;
  value: ReactNode;
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
      {drive.size ? `, ${drive.size}` : ''}
    </span>
  );
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

function qemuRows(config: GuestConfig): Row[] {
  const drives = getDrives(config);
  const disks = drives.filter((d) => d.media !== 'cdrom' && d.bus !== 'efidisk' && d.bus !== 'tpmstate' && !d.volume.includes('cloudinit'));
  const cdroms = drives.filter((d) => d.media === 'cdrom' && !d.volume.includes('cloudinit'));
  const cloudInit = drives.find((d) => d.volume.includes('cloudinit'));
  const efidisk = drives.find((d) => d.bus === 'efidisk');
  const tpm = drives.find((d) => d.bus === 'tpmstate');
  const nets = getNetSpecs(config);
  const memoryBytes = parseMemory(config.memory);
  const bootOrder = parseBootOrder(config.boot);
  const serialKeys = Object.keys(config).filter((k) => /^serial\d+$/.test(k));
  const usbKeys = Object.keys(config).filter((k) => /^usb\d+$/.test(k));
  const pciKeys = Object.keys(config).filter((k) => /^hostpci\d+$/.test(k));

  const rows: Row[] = [
    { label: 'Memory', value: memoryBytes !== null ? formatBytes(memoryBytes) : '-' },
    {
      label: 'Processors',
      value: `${config.sockets ?? 1} socket(s) × ${config.cores ?? 1} core(s)${config.cpu ? ` (${config.cpu})` : ''}${config.numa ? ', NUMA' : ''}`,
    },
    { label: 'BIOS', value: config.bios === 'ovmf' ? 'OVMF (UEFI)' : (config.bios ?? 'SeaBIOS (default)') },
    { label: 'Display', value: config.vga ?? 'default' },
    { label: 'Machine', value: config.machine ?? 'default (i440fx)' },
    { label: 'SCSI Controller', value: config.scsihw ?? 'default (LSI 53C895A)' },
  ];

  if (efidisk) rows.push({ label: 'EFI Disk', value: driveLine(efidisk) });
  if (tpm) rows.push({ label: 'TPM State', value: driveLine(tpm) });

  for (const disk of disks) {
    rows.push({
      label: `Hard Disk (${disk.key})`,
      value: (
        <div className="flex flex-col gap-1">
          {driveLine(disk)}
          {diskFlags(disk)}
        </div>
      ),
    });
  }

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
    });
  }

  for (const cdrom of cdroms) {
    rows.push({ label: `CD/DVD Drive (${cdrom.key})`, value: driveLine(cdrom) });
  }

  if (serialKeys.length > 0) {
    rows.push({
      label: 'Serial Port(s)',
      value: serialKeys.map((k) => `${k}: ${String(config[k])}`).join(', '),
    });
  }
  if (usbKeys.length > 0) {
    rows.push({ label: 'USB Device(s)', value: usbKeys.map((k) => `${k}: ${String(config[k])}`).join(', ') });
  }
  if (pciKeys.length > 0) {
    rows.push({ label: 'PCI Device(s)', value: pciKeys.map((k) => `${k}: ${String(config[k])}`).join(', ') });
  }
  if (cloudInit) rows.push({ label: 'CloudInit Drive', value: driveLine(cloudInit) });

  rows.push({ label: 'Boot Order', value: bootOrder.length > 0 ? bootOrder.join(' → ') : '-' });
  const agentEnabled = config.agent === 1 || String(config.agent ?? '').startsWith('1');
  rows.push({ label: 'QEMU Agent', value: <Flag on={agentEnabled} /> });

  return rows;
}

function lxcRows(config: GuestConfig): Row[] {
  const rootfs = getRootfsDrive(config);
  const mounts = getDrives(config).filter((d) => d.bus === 'mp');
  const nets = getNetSpecs(config);
  const memoryBytes = parseMemory(config.memory);
  const swapBytes = parseMemory(config.swap);

  const rows: Row[] = [
    { label: 'Memory', value: memoryBytes !== null ? formatBytes(memoryBytes) : '-' },
    { label: 'Swap', value: swapBytes !== null ? formatBytes(swapBytes) : '-' },
    { label: 'Cores', value: config.cores ?? '-' },
    { label: 'Unprivileged', value: <Flag on={config.unprivileged === 1} /> },
    { label: 'Features', value: config.features ?? '-' },
  ];

  if (rootfs) {
    rows.push({
      label: 'Root Disk (rootfs)',
      value: (
        <div className="flex flex-col gap-1">
          {driveLine(rootfs)}
          {diskFlags(rootfs)}
        </div>
      ),
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
    });
  }

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
    });
  }

  return rows;
}

/** Read-only Hardware tab, modelled on PVE's own Hardware panel. Derived entirely from `useVmConfig`. */
export function HardwareTab({ node, type, vmid }: VmTabProps) {
  const { data: config, isLoading, isError, error } = useVmConfig(node, type, vmid);

  if (isLoading) {
    return <Skeleton className="h-64" />;
  }
  if (isError) {
    return <EmptyState message={`Could not load configuration: ${errorMessage(error)}`} />;
  }
  if (!config) {
    return <EmptyState message="No configuration available." />;
  }

  const rows = type === 'qemu' ? qemuRows(config) : lxcRows(config);

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={`${row.label}-${i}`}>
              <TableCell className="w-56 shrink-0 align-top text-muted-foreground">{row.label}</TableCell>
              <TableCell className="align-top">{row.value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
