import { Fragment } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * One breadcrumb segment. The last item in a trail is always the current page and is rendered
 * as plain text (never a link) regardless of which variant it is.
 *
 *  - `{ label }` -- current page, not a link.
 *  - `{ label, to: 'home' }` -- links to the dashboard (`/`).
 *  - `{ label, to: 'node', node }` -- links to that node's Summary tab.
 *
 * Kept as a small discriminated union (rather than a bare `href: string`) so every link target
 * stays fully typed against the route tree -- no `any`/string-cast escape hatch for TanStack
 * Router's typed `Link`.
 */
export type BreadcrumbItem =
  | { label: string; to?: undefined }
  | { label: string; to: 'home' }
  | { label: string; to: 'node'; node: string };

export interface BreadcrumbsProps {
  items: BreadcrumbItem[];
}

/**
 * Compact breadcrumb trail for a page header: "Datacenter › Tasks", "Datacenter › pve1", etc.
 * Small, muted text with a single chevron separator -- no icons, no mono, nothing decorative.
 */
export function Breadcrumbs({ items }: BreadcrumbsProps) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center text-xs text-muted-foreground">
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        return (
          <Fragment key={`${item.label}-${index}`}>
            {index > 0 && (
              <ChevronRight aria-hidden="true" className="mx-1 size-3 shrink-0 text-muted-foreground/60" />
            )}
            {isLast || !item.to ? (
              <span className={cn('truncate', isLast && 'text-foreground')}>{item.label}</span>
            ) : item.to === 'home' ? (
              <Link to="/" className="truncate outline-none hover:text-foreground hover:underline focus-visible:text-foreground">
                {item.label}
              </Link>
            ) : (
              <Link
                to="/node/$node"
                params={{ node: item.node }}
                search={{ tab: 'summary' }}
                className="truncate outline-none hover:text-foreground hover:underline focus-visible:text-foreground"
              >
                {item.label}
              </Link>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
