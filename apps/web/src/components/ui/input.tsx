import * as React from 'react';

import { cn } from '@/lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none',
        'file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium',
        'placeholder:text-muted-foreground selection:bg-accent selection:text-accent-foreground',
        // The disabled look lives in index.css (`[data-slot='input']:disabled`), not in
        // `disabled:` utilities: password managers read class NAMES, not styles, and Keeper
        // skips a field whose class attribute contains "opacity" (bisected on the live site:
        // `disabled:opacity-50` alone was enough; a made-up "disabled-marker" class was not).
        // So a login field must never carry such a token.
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        'aria-invalid:ring-destructive/20 aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
