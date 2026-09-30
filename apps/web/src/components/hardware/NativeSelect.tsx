import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * A styled native `<select>`, for the hardware dialogs' pickers: CPU model grouped by vendor
 * (`<optgroup>`) and ISO image grouped by storage. A native element keeps the grouping, keyboard
 * and mobile behaviour for free, and stays trivially testable; it is styled to match `Input`.
 */
export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        'flex h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground shadow-xs outline-none',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        className,
      )}
      {...props}
    />
  );
}
