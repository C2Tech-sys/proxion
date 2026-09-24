import type { SVGProps } from 'react';
import {
  MARK_DEFAULT,
  MARK_VIEWBOX,
  ORBIT,
  hexagonPoints,
  ionPosition,
} from '@/brand/mark';
import { cn } from '@/lib/utils';

const CENTER = MARK_VIEWBOX / 2;
const ION = ionPosition();
const HEX = hexagonPoints(MARK_DEFAULT.hexRadius);

/**
 * The Proxion mark, themed: the node (hexagon) follows `currentColor` so it sits in the
 * foreground colour of wherever it's placed; the orbit and ion use the accent token, same
 * as focus rings and active nav. Geometry comes from `src/brand/mark.ts` (shared with the
 * favicon build) -- change it there, not here.
 *
 * Decorative by default (`aria-hidden`): the wordmark or link next to it carries the name.
 */
export function Logo({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`}
      aria-hidden="true"
      focusable="false"
      className={cn('shrink-0', className)}
      {...props}
    >
      <polygon
        points={HEX}
        fill="none"
        stroke="currentColor"
        strokeWidth={MARK_DEFAULT.hexStroke}
        strokeLinejoin="round"
      />
      <ellipse
        cx={CENTER}
        cy={CENTER}
        rx={ORBIT.rx}
        ry={ORBIT.ry}
        transform={`rotate(${ORBIT.tiltDeg} ${CENTER} ${CENTER})`}
        fill="none"
        className="stroke-accent"
        strokeWidth={MARK_DEFAULT.orbitStroke}
        strokeLinecap="round"
      />
      <circle cx={ION.x} cy={ION.y} r={MARK_DEFAULT.ionRadius} className="fill-accent" />
    </svg>
  );
}
