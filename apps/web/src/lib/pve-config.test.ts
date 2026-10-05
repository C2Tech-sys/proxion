import { describe, expect, it } from 'vitest';

import {
  cpuHasExtraOptions,
  gibToResizeSize,
  isMountableIsoVolid,
  parseCpuModel,
  parseSizeToGiB,
  getDrives,
  getNetSpecs,
  getRootfsDrive,
  isIPv4,
  isIPv4Cidr,
  isIPv6,
  isIPv6Cidr,
  isUnicastMac,
  isValidMac,
  nextFreeNetSlot,
  parseNicConfig,
  unmodeledNicParts,
  parseGuestBootOrder,
  listBootCandidates,
  parseDriveSpec,
  parseMemory,
  parseNetSpec,
  parseAgent,
  parseGuestOptions,
  parseHotplug,
  parseNameservers,
  parseStartup,
  parseTags,
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

describe('parseSizeToGiB / gibToResizeSize (T48)', () => {
  it('parses PVE size suffixes into GiB', () => {
    expect(parseSizeToGiB('32G')).toBe(32);
    expect(parseSizeToGiB('512M')).toBe(0.5);
    expect(parseSizeToGiB('2T')).toBe(2048);
    expect(parseSizeToGiB('1073741824')).toBe(1);
    expect(parseSizeToGiB(undefined)).toBeNull();
    expect(parseSizeToGiB('lots')).toBeNull();
  });

  it('builds the grow-only resize string', () => {
    expect(gibToResizeSize(10)).toBe('+10G');
    expect(gibToResizeSize(1.5)).toBe('+1536M');
  });
});

describe('isMountableIsoVolid (T48)', () => {
  it('accepts iso/img volumes with any extension case', () => {
    expect(isMountableIsoVolid('local:iso/debian-12.iso')).toBe(true);
    expect(isMountableIsoVolid('local:iso/Win11.ISO')).toBe(true);
    expect(isMountableIsoVolid('nfs-iso:iso/disk.Img')).toBe(true);
  });

  it('rejects other content, traversal and other extensions', () => {
    expect(isMountableIsoVolid('local:vztmpl/a.iso')).toBe(false);
    expect(isMountableIsoVolid('local:iso/a..b.iso')).toBe(false);
    expect(isMountableIsoVolid('local:iso/a.isox')).toBe(false);
    expect(isMountableIsoVolid('local:iso/a.iso,media=disk')).toBe(false);
  });
});

describe('parseCpuModel / cpuHasExtraOptions (T48)', () => {
  it('reads the model from a bare or cputype= property string', () => {
    expect(parseCpuModel('host')).toBe('host');
    expect(parseCpuModel('host,flags=+aes')).toBe('host');
    expect(parseCpuModel('cputype=x86-64-v2-AES,hidden=1')).toBe('x86-64-v2-AES');
    expect(parseCpuModel(undefined)).toBeUndefined();
    expect(parseCpuModel('flags=+aes')).toBeUndefined();
  });

  it('detects options beyond the model', () => {
    expect(cpuHasExtraOptions('host')).toBe(false);
    expect(cpuHasExtraOptions('host,flags=+aes')).toBe(true);
    expect(cpuHasExtraOptions(undefined)).toBe(false);
  });
});

describe('parseGuestBootOrder / listBootCandidates (T51)', () => {
  const config: GuestConfig = {
    scsi0: 'local-lvm:vm-100-disk-0,size=32G',
    sata1: 'tank:vm-100-disk-1,size=8G',
    ide2: 'local:iso/x.iso,media=cdrom',
    ide3: 'tank:vm-100-cloudinit,media=cdrom',
    net0: 'virtio=BC:24:11:64:00:01,bridge=vmbr0',
    net1: 'e1000=BC:24:11:64:00:02,bridge=vmbr1',
    efidisk0: 'tank:vm-100-disk-2,size=4M',
    tpmstate0: 'tank:vm-100-disk-3,size=4M',
    unused0: 'tank:vm-100-disk-9',
    boot: 'order=scsi0;ide2;net0',
  };

  it('parses the modern order= form', () => {
    expect(parseGuestBootOrder(config)).toEqual({ order: ['scsi0', 'ide2', 'net0'], legacy: false });
  });

  it('parses a modern value with extra properties and de-duplicates', () => {
    expect(parseGuestBootOrder({ ...config, boot: 'order=net0;scsi0;net0,legacy=cdn' }).order).toEqual([
      'net0',
      'scsi0',
    ]);
  });

  it('parses the legacy letters: c = bootdisk, d = first CD-ROM, n = first NIC', () => {
    expect(parseGuestBootOrder({ ...config, boot: 'cdn', bootdisk: 'scsi0' })).toEqual({
      order: ['scsi0', 'ide2', 'net0'],
      legacy: true,
    });
    expect(parseGuestBootOrder({ ...config, boot: 'legacy=ndc', bootdisk: 'sata1' })).toEqual({
      order: ['net0', 'ide2', 'sata1'],
      legacy: true,
    });
  });

  it('skips legacy letters that have no device (no bootdisk, unknown letter)', () => {
    expect(parseGuestBootOrder({ ...config, boot: 'cdnx' }).order).toEqual(['ide2', 'net0']);
  });

  it('never maps the legacy d letter to a cloud-init drive', () => {
    const onlyCloudInit: GuestConfig = { ide3: 'tank:vm-100-cloudinit,media=cdrom', boot: 'd' };
    expect(parseGuestBootOrder(onlyCloudInit).order).toEqual([]);
  });

  it('returns an empty, non-legacy order without a boot key', () => {
    expect(parseGuestBootOrder({ scsi0: 'tank:vm-100-disk-0,size=32G' })).toEqual({ order: [], legacy: false });
  });

  it('lists disks, CD-ROMs and NICs with descriptions, excluding cloud-init/EFI/TPM/unused', () => {
    expect(listBootCandidates(config)).toEqual([
      { key: 'ide2', label: 'ide2 — CD/DVD: local:iso/x.iso' },
      { key: 'sata1', label: 'sata1 — tank:vm-100-disk-1 (8G)' },
      { key: 'scsi0', label: 'scsi0 — local-lvm:vm-100-disk-0 (32G)' },
      { key: 'net0', label: 'net0 — virtio, vmbr0' },
      { key: 'net1', label: 'net1 — e1000, vmbr1' },
    ]);
  });

  it('labels an empty CD-ROM drive "No media"', () => {
    expect(listBootCandidates({ ide2: 'none,media=cdrom' })).toEqual([{ key: 'ide2', label: 'ide2 — CD/DVD: No media' }]);
  });
});

describe('network device helpers (T50)', () => {
  it('parseNicConfig reads every editable qemu field', () => {
    expect(
      parseNicConfig(
        'qemu',
        'net0',
        'e1000e=BC:24:11:64:00:01,bridge=vmbr1,tag=20,firewall=1,rate=12.5,link_down=1,mtu=1500',
      ),
    ).toEqual({
      key: 'net0',
      model: 'e1000e',
      mac: 'BC:24:11:64:00:01',
      bridge: 'vmbr1',
      vlan: 20,
      firewall: true,
      rate: 12.5,
      linkDown: true,
      mtu: 1500,
    });
  });

  it('parseNicConfig handles a bare qemu model (no MAC) and absent options', () => {
    expect(parseNicConfig('qemu', 'net2', 'virtio,bridge=vmbr0')).toEqual({
      key: 'net2',
      model: 'virtio',
      mac: undefined,
      bridge: 'vmbr0',
      vlan: undefined,
      firewall: false,
      rate: undefined,
      linkDown: false,
      mtu: undefined,
    });
  });

  it('parseNicConfig reads every editable lxc field', () => {
    expect(
      parseNicConfig(
        'lxc',
        'net1',
        'name=eth1,bridge=vmbr0,firewall=1,hwaddr=BC:24:11:C8:00:01,ip=10.0.0.5/24,gw=10.0.0.1,ip6=auto,type=veth,tag=30',
      ),
    ).toMatchObject({
      key: 'net1',
      name: 'eth1',
      bridge: 'vmbr0',
      firewall: true,
      mac: 'BC:24:11:C8:00:01',
      ip: '10.0.0.5/24',
      gw: '10.0.0.1',
      ip6: 'auto',
      gw6: undefined,
      vlan: 30,
      linkDown: false,
    });
  });

  it('unmodeledNicParts keeps only what the dialog does not model, verbatim and in order', () => {
    expect(
      unmodeledNicParts('qemu', 'virtio=BC:24:11:64:00:01,bridge=vmbr0,queues=4,tag=20,trunks=10;20,link_down=1'),
    ).toEqual(['queues=4', 'trunks=10;20']);
    expect(unmodeledNicParts('qemu', 'virtio,bridge=vmbr0')).toEqual([]);
    expect(unmodeledNicParts('qemu', 'virtio,macaddr=BC:24:11:64:00:01,bridge=vmbr0')).toEqual([]);
    expect(
      unmodeledNicParts('lxc', 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:C8:00:01,ip=dhcp,link_down=1,type=veth'),
    ).toEqual(['link_down=1', 'type=veth']);
    expect(unmodeledNicParts('qemu', undefined)).toEqual([]);
  });

  it('nextFreeNetSlot picks the first gap, and undefined when full', () => {
    expect(nextFreeNetSlot({ net0: 'a', net1: 'b', net3: 'c' })).toBe('net2');
    expect(nextFreeNetSlot({})).toBe('net0');
    const full: GuestConfig = {};
    for (let n = 0; n < 32; n++) full[`net${n}`] = 'virtio';
    expect(nextFreeNetSlot(full)).toBeUndefined();
  });

  it('validates MACs (unicast only for devices)', () => {
    expect(isValidMac('BC:24:11:64:00:01')).toBe(true);
    expect(isValidMac('bc:24:11:64:00:01')).toBe(true);
    expect(isValidMac('BC-24-11-64-00-01')).toBe(false);
    expect(isValidMac('BC:24:11:64:00')).toBe(false);
    expect(isUnicastMac('BC:24:11:64:00:01')).toBe(true);
    expect(isUnicastMac('01:00:5E:00:00:01')).toBe(false);
    expect(isUnicastMac('03:00:00:00:00:01')).toBe(false);
  });

  it('validates IPv4 / IPv6 addresses and CIDRs', () => {
    expect(isIPv4('10.0.0.1')).toBe(true);
    expect(isIPv4('10.0.0.256')).toBe(false);
    expect(isIPv4('10.0.0')).toBe(false);
    expect(isIPv4Cidr('10.0.0.5/24')).toBe(true);
    expect(isIPv4Cidr('10.0.0.5/33')).toBe(false);
    expect(isIPv4Cidr('10.0.0.5')).toBe(false);
    expect(isIPv6('fd00::1')).toBe(true);
    expect(isIPv6('::1')).toBe(true);
    expect(isIPv6('::')).toBe(true);
    expect(isIPv6('2001:db8:0:0:0:0:0:1')).toBe(true);
    expect(isIPv6('::ffff:10.0.0.1')).toBe(true);
    expect(isIPv6('fd00:::1')).toBe(false);
    expect(isIPv6('fd00::1::2')).toBe(false);
    expect(isIPv6('2001:db8:0:0:0:0:0:0:1')).toBe(false);
    expect(isIPv6('fd00')).toBe(false);
    expect(isIPv6('gggg::1')).toBe(false);
    expect(isIPv6Cidr('fd00::5/64')).toBe(true);
    expect(isIPv6Cidr('fd00::5/129')).toBe(false);
    expect(isIPv6Cidr('fd00::5')).toBe(false);
  });
});

describe('parseGuestOptions (T53)', () => {
  it('parses startup in any order and with any subset of parts', () => {
    expect(parseStartup('order=3,up=30,down=60')).toStrictEqual({ order: 3, up: 30, down: 60 });
    expect(parseStartup('down=10,order=1')).toStrictEqual({ order: 1, down: 10 });
    expect(parseStartup('order=any')).toBeUndefined();
    expect(parseStartup('')).toBeUndefined();
    expect(parseStartup(undefined)).toBeUndefined();
  });

  it('parses the agent property string, the legacy bare flag and numbers', () => {
    expect(parseAgent('enabled=1,fstrim_cloned_disks=1,type=isa')).toStrictEqual({
      enabled: true,
      fstrimClonedDisks: true,
    });
    expect(parseAgent('enabled=0')).toStrictEqual({ enabled: false, fstrimClonedDisks: false });
    expect(parseAgent('1')).toStrictEqual({ enabled: true, fstrimClonedDisks: false });
    expect(parseAgent('1,fstrim_cloned_disks=1')).toStrictEqual({ enabled: true, fstrimClonedDisks: true });
    expect(parseAgent(1)).toStrictEqual({ enabled: true, fstrimClonedDisks: false });
    expect(parseAgent(0)).toStrictEqual({ enabled: false, fstrimClonedDisks: false });
    expect(parseAgent(undefined)).toStrictEqual({ enabled: false, fstrimClonedDisks: false });
  });

  it('splits tags on ; , and whitespace', () => {
    expect(parseTags('prod;web')).toStrictEqual(['prod', 'web']);
    expect(parseTags('a, b  c;;d')).toStrictEqual(['a', 'b', 'c', 'd']);
    expect(parseTags('')).toStrictEqual([]);
    expect(parseTags(undefined)).toStrictEqual([]);
  });

  it('reads hotplug: absent and 1 are the default set, 0 is none, a list keeps PVE order', () => {
    expect(parseHotplug(undefined)).toStrictEqual({ items: ['network', 'disk', 'usb'], isDefault: true });
    expect(parseHotplug('1')).toStrictEqual({ items: ['network', 'disk', 'usb'], isDefault: true });
    expect(parseHotplug('0')).toStrictEqual({ items: [], isDefault: false });
    expect(parseHotplug('usb,network,cpu,bogus')).toStrictEqual({
      items: ['network', 'cpu', 'usb'],
      isDefault: false,
    });
  });

  it('splits nameservers on whitespace and commas', () => {
    expect(parseNameservers('1.1.1.1 8.8.8.8')).toStrictEqual(['1.1.1.1', '8.8.8.8']);
    expect(parseNameservers('1.1.1.1,fd00::1')).toStrictEqual(['1.1.1.1', 'fd00::1']);
    expect(parseNameservers(undefined)).toStrictEqual([]);
  });

  it('maps a qemu config into typed fields (and leaves the lxc-only ones empty)', () => {
    const options = parseGuestOptions(
      { startup: 'order=2', agent: 'enabled=1', tags: 'prod;web', hotplug: 'network,disk', nameserver: '9.9.9.9' },
      'qemu',
    );
    expect(options).toStrictEqual({
      startup: { order: 2 },
      agent: { enabled: true, fstrimClonedDisks: false },
      tags: ['prod', 'web'],
      hotplug: ['network', 'disk'],
      hotplugIsDefault: false,
      nameserver: [],
      searchdomain: undefined,
    });
  });

  it('maps an lxc config into typed fields (and leaves the qemu-only ones undefined)', () => {
    const options = parseGuestOptions(
      { startup: 'up=15', tags: 'lab', nameserver: '1.1.1.1 8.8.8.8', searchdomain: 'lan', agent: '1' },
      'lxc',
    );
    expect(options).toStrictEqual({
      startup: { up: 15 },
      agent: undefined,
      tags: ['lab'],
      hotplug: undefined,
      hotplugIsDefault: false,
      nameserver: ['1.1.1.1', '8.8.8.8'],
      searchdomain: 'lan',
    });
  });

  it('an empty config yields no startup, no tags, the default hotplug and a disabled agent', () => {
    expect(parseGuestOptions({}, 'qemu')).toStrictEqual({
      startup: undefined,
      agent: { enabled: false, fstrimClonedDisks: false },
      tags: [],
      hotplug: ['network', 'disk', 'usb'],
      hotplugIsDefault: true,
      nameserver: [],
      searchdomain: undefined,
    });
  });
});
