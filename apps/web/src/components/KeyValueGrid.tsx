import type { ReactNode } from 'react';

export interface KeyValueRow {
  label: string;
  value: ReactNode;
}

export interface KeyValueGridProps {
  rows: KeyValueRow[];
}

/** A dense label/value grid used inside Panels (Hardware, Guest, etc.). */
export function KeyValueGrid({ rows }: KeyValueGridProps) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-sm">
      {rows.map((row) => (
        <div className="contents" key={row.label}>
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 truncate text-right text-[13px] font-numeric">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
