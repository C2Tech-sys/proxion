import { describe, expect, it } from 'vitest';

import {
  getDrives,
  getNetSpecs,
  getRootfsDrive,
  parseBootOrder,
  parseDriveSpec,
  parseMemory,
  parseNetSpec,
} from '@/lib/pve-config';
import type { GuestConfig } from '@/api/types';

describe('parseDriveSpec', () => {
  it('parses a qemu disk with discard/ssd/iothread flags', () => {
    const drive = parseDriveSpec('scsi0', 'tank:vm-100-disk-0,size=64G,discard=on,ssd=1,iothread=1');
    expect(drive).toMatchObject({
      key: 'scsi0',
      bus: 'scsi',
      index: 0,
      storage: 'tank',
      volume: 'vm-100-disk-0',
      size: '64G',
      discard: true,
      ssd: true,
      iothread: true,
      media: undefined,
    });
  });

  it('parses a CD-ROM drive', () => {
    const drive = parseDriveSpec('ide2', 'local:iso/debian-12.iso,media=cdrom');
    expect(drive).toMatchObject({
      key: 'ide2',
      bus: 'ide',
      index: 2,
      storage: 'local',
      volume: 'iso/debian-12.iso',
      media: 'cdrom',
      size: undefined,
    });
  });

  it('parses an EFI disk and leaves unmodelled fields in `options`', () => {
    const drive = parseDriveSpec('efidisk0', 'tank:vm-100-disk-2,efitype=4m,pre-enrolled-keys=1,size=4M');
    expect(drive.bus).toBe('efidisk');
    expect(drive.storage).toBe('tank');
    expect(drive.size).toBe('4M');
    expect(drive.options.efitype).toBe('4m');
    expect(drive.options['pre-enrolled-keys']).toBe('1');
  });

  it('parses a TPM state drive', () => {
    const drive = parseDriveSpec('tpmstate0', 'tank:vm-100-disk-3,size=4M,version=v2.0');
    expect(drive.bus).toBe('tpmstate');
    expect(drive.options.version).toBe('v2.0');
  });

  it('parses an lxc mount point', () => {
    const drive = parseDriveSpec('mp0', 'tank:subvol-200-disk-1,mp=/data,size=16G');
    expect(drive).toMatchObject({ bus: 'mp', index: 0, storage: 'tank', volume: 'subvol-200-disk-1', size: '16G' });
    expect(drive.options.mp).toBe('/data');
  });

  it('treats missing flags as undefined, not false', () => {
    const drive = parseDriveSpec('scsi0', 'tank:vm-100-disk-0,size=32G');
    expect(drive.discard).toBeUndefined();
    expect(drive.ssd).toBeUndefined();
    expect(drive.iothread).toBeUndefined();
  });
});

describe('parseNetSpec', () => {
  it('parses a qemu NIC with a VLAN tag', () => {
    const net = parseNetSpec('net0', 'virtio=BC:24:11:AA:BB:CC,bridge=vmbr0,firewall=1,tag=20');
    expect(net).toMatchObject({
      key: 'net0',
      index: 0,
      model: 'virtio',
      mac: 'BC:24:11:AA:BB:CC',
      bridge: 'vmbr0',
      firewall: true,
      tag: 20,
    });
  });

  it('parses a qemu NIC with a rate limit and no VLAN', () => {
    const net = parseNetSpec('net1', 'virtio=BC:24:11:AA:BB:CD,bridge=vmbr0,rate=10');
    expect(net.rate).toBe('10');
    expect(net.tag).toBeUndefined();
  });

  it('parses an lxc NIC (name/hwaddr/ip/type shape)', () => {
    const net = parseNetSpec(
      'net0',
      'name=eth0,bridge=vmbr0,firewall=1,hwaddr=BC:24:11:C8:00:01,ip=dhcp,type=veth',
    );
    expect(net).toMatchObject({
      name: 'eth0',
      bridge: 'vmbr0',
      firewall: true,
      hwaddr: 'BC:24:11:C8:00:01',
      ip: 'dhcp',
      type: 'veth',
      model: undefined,
    });
  });
});

describe('parseBootOrder', () => {
  it('parses a modern order= boot string', () => {
    expect(parseBootOrder('order=scsi0;net0')).toEqual(['scsi0', 'net0']);
  });

  it('parses a single-device order= boot string', () => {
    expect(parseBootOrder('order=scsi0')).toEqual(['scsi0']);
  });

  it('returns [] for undefined', () => {
    expect(parseBootOrder(undefined)).toEqual([]);
  });

  it('falls back to per-character codes for legacy boot strings', () => {
    expect(parseBootOrder('cdn')).toEqual(['c', 'd', 'n']);
  });
});

describe('parseMemory', () => {
  it('converts a numeric MiB value to bytes', () => {
    expect(parseMemory(4096)).toBe(4096 * 1024 * 1024);
  });

  it('converts a numeric-string MiB value to bytes', () => {
    expect(parseMemory('16384')).toBe(16384 * 1024 * 1024);
  });

  it('returns null when unset', () => {
    expect(parseMemory(undefined)).toBeNull();
  });

  it('returns null for an unparseable string', () => {
    expect(parseMemory('lots')).toBeNull();
  });
});

describe('getDrives / getRootfsDrive / getNetSpecs', () => {
  it('collects every drive-like key from a qemu config, ignoring net/other keys', () => {
    const config: GuestConfig = {
      scsi0: 'tank:vm-100-disk-0,size=32G',
      scsi1: 'tank:vm-100-disk-1,size=16G',
      ide2: 'local:iso/debian-12.iso,media=cdrom',
      efidisk0: 'tank:vm-100-disk-2,size=4M',
      tpmstate0: 'tank:vm-100-disk-3,size=4M',
      net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0',
      cores: 4,
    };
    const drives = getDrives(config);
    expect(drives.map((d) => d.key).sort()).toEqual(['efidisk0', 'ide2', 'scsi0', 'scsi1', 'tpmstate0']);
  });

  it('parses the lxc rootfs drive', () => {
    const config: GuestConfig = { rootfs: 'local-zfs:subvol-200-disk-0,size=8G' };
    expect(getRootfsDrive(config)).toMatchObject({ storage: 'local-zfs', volume: 'subvol-200-disk-0', size: '8G' });
  });

  it('returns null rootfs for a qemu config', () => {
    const config: GuestConfig = { scsi0: 'tank:vm-100-disk-0,size=32G' };
    expect(getRootfsDrive(config)).toBeNull();
  });

  it('collects every netN key', () => {
    const config: GuestConfig = {
      net0: 'virtio=AA:BB:CC:DD:EE:01,bridge=vmbr0',
      net1: 'virtio=AA:BB:CC:DD:EE:02,bridge=vmbr0,tag=20',
      scsi0: 'tank:vm-100-disk-0,size=32G',
    };
    expect(getNetSpecs(config).map((n) => n.key).sort()).toEqual(['net0', 'net1']);
  });
});
