import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';

export interface TagChipProps {
  tag: string;
  className?: string;
}

/**
 * A small colored chip for a PVE tag. Hue is derived deterministically from the tag text;
 * lightness/chroma/alpha come from the `--chip-*` theme tokens (see index.css) so contrast
 * stays at AA in both light and dark mode instead of a single fixed-lightness value.
 */
export function TagChip({ tag, className }: TagChipProps) {
  const hue = hashHue(tag);
  return (
    <span
      className={cn(
        'tag-chip inline-flex h-4 items-center rounded-sm border px-1 text-[10px] leading-none font-medium whitespace-nowrap',
        className,
      )}
      style={{ '--chip-hue': hue } as CSSProperties}
    >
      {tag}
    </span>
  );
}

function hashHue(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}
