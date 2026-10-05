import type { PciFields, SerialFields, UsbFields } from '@/lib/pve-config';

/** One-line, human-readable summaries of a parsed device, for the Hardware tab's rows. */

export function describeUsb(usb: UsbFields, raw: string): string {
  const suffix = usb.usb3 ? ', USB 3' : '';
  switch (usb.source) {
    case 'spice':
      return `Spice port${suffix}`;
    case 'vendor':
      return `Host device ${usb.id}${suffix}`;
    case 'port':
      return `Host port ${usb.port}${suffix}`;
    case 'mapping':
      return `Mapped device ${usb.mapping}${suffix}`;
    default:
      return raw;
  }
}

export function describePci(pci: PciFields, raw: string): string {
  if (pci.source === 'unknown') return raw;
  const bits: string[] = [
    pci.source === 'mapping' ? `Mapped device ${pci.mapping}` : `Host device ${pci.id}${pci.allFunctions ? ' (all functions)' : ''}`,
  ];
  if (pci.pcie) bits.push('PCI-Express');
  if (!pci.rombar) bits.push('ROM-Bar off');
  if (pci.xVga) bits.push('primary GPU');
  if (pci.mdev) bits.push(`mdev ${pci.mdev}`);
  return bits.join(', ');
}

export function describeSerial(serial: SerialFields): string {
  return serial.target === 'socket' ? 'Socket' : `Host device ${serial.target}`;
}
