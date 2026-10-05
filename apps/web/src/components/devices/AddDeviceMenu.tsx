import { Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { DeviceKind } from '@/lib/pve-config';

export interface AddDeviceMenuProps {
  /** When set, the button is disabled and this is its tooltip (same wording as the edit pencils). */
  disabledReason?: string | undefined;
  onPick: (kind: DeviceKind) => void;
}

/** The "Add device" menu in the Hardware tab's Devices header row: USB device / PCI device / Serial port. */
export function AddDeviceMenu({ disabledReason, onPick }: AddDeviceMenuProps) {
  const disabled = disabledReason !== undefined;
  const button = (
    <Button
      variant="outline"
      size="sm"
      className="h-7 shrink-0"
      disabled={disabled}
      aria-disabled={disabled || undefined}
      title={disabledReason}
    >
      <Plus className="size-3.5" />
      Add device
    </Button>
  );
  if (disabled) return button;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onPick('usb')}>USB device</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onPick('pci')}>PCI device</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onPick('serial')}>Serial port</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
