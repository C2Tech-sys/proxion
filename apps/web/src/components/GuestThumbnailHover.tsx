import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

import { ConsoleThumbnail } from '@/components/ConsoleThumbnail';
import { usePrefs } from '@/api/prefsHooks';
import type { GuestNode } from '@/lib/tree';
import { cn } from '@/lib/utils';

const OPEN_DELAY_MS = 400;
const CLOSE_DELAY_MS = 150;
const CARD_WIDTH_PX = 240;
/** Gap between the rail's right edge and the card. */
const RAIL_GAP_PX = 6;
/** Kept clear of every viewport edge. */
const VIEWPORT_MARGIN_PX = 8;
/**
 * The card's own rendered height can't be measured before it's positioned -- jsdom does no
 * layout at all (every `getBoundingClientRect()` reads back zero), and even in a real browser
 * measuring first would mean an extra layout + reposition pass (a visible jump) before the first
 * paint. Used only to keep the card fully on-screen, this is a fixed estimate instead: the
 * thumbnail's own `aspect-[4/3]` at `CARD_WIDTH_PX` (180px) plus the caption line (`px-2 py-1
 * text-[11px]`, ~20px) plus the card's 1px top+bottom border. A few px of slack either way just
 * means the card sits a few px higher than it strictly needed to -- never clipped.
 */
const CARD_HEIGHT_PX = Math.round((CARD_WIDTH_PX * 3) / 4) + 22;

interface CardPosition {
  top: number;
  left: number;
}

/**
 * Where the card goes, in viewport (`position: fixed`) coordinates -- to the right of the whole
 * rail (not just this row, so a wide row never makes the card overlap the rail: see `railRect`),
 * vertically aligned with the row but clamped so it never runs off the top/bottom, and clamped
 * horizontally too in case the rail is flush against the right edge of a narrow window.
 */
function computeCardPosition(rowRect: DOMRect, railRect: DOMRect): CardPosition {
  const maxLeft = window.innerWidth - CARD_WIDTH_PX - VIEWPORT_MARGIN_PX;
  const left = Math.min(railRect.right + RAIL_GAP_PX, Math.max(VIEWPORT_MARGIN_PX, maxLeft));

  const maxTop = window.innerHeight - CARD_HEIGHT_PX - VIEWPORT_MARGIN_PX;
  const top = Math.max(VIEWPORT_MARGIN_PX, Math.min(rowRect.top, maxTop));

  return { top, left };
}

/**
 * Whether hover previews are worth showing on this device: a touch/coarse-pointer device has no
 * real "hover" state, so opening the card on tap would just be in the way. Read lazily on every
 * call (not cached at import time) via the live `window.matchMedia`, so plugging in a mouse -- or
 * a hybrid device switching input methods -- is respected without a reload, and so it is fully
 * injectable for tests simply by stubbing `matchMedia` itself (as `ConsoleThumbnail.test.tsx`
 * already does for `fetch`/`IntersectionObserver`/`open`), the same global a real browser
 * provides -- no test-only export needed here. jsdom has no `matchMedia` of its own, and
 * `test/setup.ts` installs a quiet default that always reports `matches: false` for every query
 * (see its comment); this file's own test suite overrides that per-suite to default to enabled,
 * since a hover card that never shows up in jsdom would leave the rest of this file untested.
 */
function hasFinePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  } catch {
    return false;
  }
}

/**
 * "Only one hover card open at a time", coordinated across every `GuestThumbnailHover` mounted in
 * the tree: claiming the slot closes whichever other instance currently holds it, the same way a
 * native tooltip never shows two at once. A plain module-level slot rather than context/state --
 * there is at most one of these cards open anywhere in the app, so there is nothing to render or
 * subscribe a provider for.
 */
let releaseCurrentSlot: (() => void) | null = null;

function claimSingleOpenSlot(release: () => void): void {
  if (releaseCurrentSlot && releaseCurrentSlot !== release) releaseCurrentSlot();
  releaseCurrentSlot = release;
}

function vacateSingleOpenSlot(release: () => void): void {
  if (releaseCurrentSlot === release) releaseCurrentSlot = null;
}

export interface GuestThumbnailHoverProps {
  guest: Pick<GuestNode, 'node' | 'type' | 'vmid' | 'name' | 'status' | 'template'>;
  /** The trigger row -- a single element (the guest row's `Link`, wrapped in its context menu)
   *  this wraps in a plain positioning `<div>` used only to attach hover/focus handlers and to
   *  measure the row's position; the floating card itself renders through a portal (see below),
   *  never as a descendant of this div. */
  children: ReactElement;
}

/**
 * Wraps one inventory-tree guest row with a floating console-preview card: pointer hover (after
 * a 400ms open delay, so scanning down the rail doesn't fire a fetch per row it passes over) or
 * keyboard focus shows a compact `ConsoleThumbnail` plus a "name · vmid" caption to the right of
 * the row. Closes 150ms after the pointer leaves the row, immediately on blur, and immediately if
 * the rail (or anything else) scrolls.
 *
 * The card is portaled to `document.body` and positioned with `position: fixed` from the row's
 * (and the rail's) `getBoundingClientRect()` -- the inventory rail is a narrow, vertically
 * scrolling panel (`role="tree"`, `overflow-y-auto`) inside a resizable split pane, so an
 * in-flow `position: absolute` card would be clipped by that `overflow-y-auto` the moment the
 * row's width plus the card's own width exceeded the rail's width, which is most of the time.
 * Non-interactive (`pointer-events-none`) and `role="tooltip"`: it is a preview, not something to
 * click or hover into, so there is no "moving the pointer onto the card keeps it open" grace
 * period to build -- leaving the row is what closes it.
 *
 * Only for a running, non-template guest, only while the `consoleThumbnails` preference is on
 * (undefined/loading counts as on, matching the dashboard's own Consoles panel), and only on a
 * fine-pointer device (see `hasFinePointer` above) -- a touch tap has no hover to trigger this
 * from, and forcing it open on tap would just cover the row underneath.
 *
 * No fetch happens until the card is actually open: `ConsoleThumbnail` is not mounted at all
 * while closed, so its own visibility-gated fetch effect never runs for it.
 */
export function GuestThumbnailHover({ guest, children }: GuestThumbnailHoverProps) {
  const { data: prefs } = usePrefs();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CardPosition | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const eligible = guest.status === 'running' && guest.template !== true;
  const enabled = eligible && prefs?.consoleThumbnails !== false && hasFinePointer();

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== undefined) clearTimeout(openTimerRef.current);
    if (closeTimerRef.current !== undefined) clearTimeout(closeTimerRef.current);
    openTimerRef.current = undefined;
    closeTimerRef.current = undefined;
  }, []);

  const closeNow = useCallback(() => {
    clearTimers();
    setOpen(false);
  }, [clearTimers]);

  /** Measures the row and the rail (its closest `role="tree"` ancestor, or itself if there is
   *  none -- e.g. this component used somewhere outside the inventory tree) and stores the
   *  card's position. Called right before opening, and again on every resize while open so the
   *  card doesn't drift out of place under the row if the window is resized. */
  const reposition = useCallback(() => {
    const rowEl = rowRef.current;
    if (!rowEl) return;
    const railEl = (rowEl.closest('[role="tree"]') as HTMLElement | null) ?? rowEl;
    setPos(computeCardPosition(rowEl.getBoundingClientRect(), railEl.getBoundingClientRect()));
  }, []);

  // Release this instance's claim on the single-open slot whenever it closes (by any path) or
  // unmounts -- otherwise a row that closed without ever losing the slot (e.g. the guest flipped
  // to stopped while its card was open) would wrongly go on blocking every other row's card.
  useEffect(() => {
    if (!open) vacateSingleOpenSlot(closeNow);
    return () => vacateSingleOpenSlot(closeNow);
  }, [open, closeNow]);

  // A guest that stops being eligible while its card is open (status flips, or the preference is
  // turned off elsewhere) closes it immediately rather than leaving a stale preview on screen.
  // Adjusted here during render -- `useState` (not a ref: refs may not be read during render),
  // the pattern React's own docs recommend for reacting to a prop change without an effect
  // (https://react.dev/learn/you-might-not-need-an-effect) -- rather than in a `useEffect`, which
  // would call `setState` synchronously inside the effect body. Any timer already pending (there
  // can be at most a stale close timer; open never coexists with a pending open timer) is
  // harmless: it will still fire, but `scheduleOpen`/`closeNow` re-check `open`/`enabled` then.
  const [wasEnabled, setWasEnabled] = useState(enabled);
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    if (open && !enabled) setOpen(false);
  }

  // Scroll doesn't bubble, so this has to be a capture-phase document listener to catch a scroll
  // on the rail's own scroll container (or any ancestor) rather than a handler placed on it.
  // Closing outright (rather than repositioning) sidesteps having to track the row's position on
  // every scroll tick -- the ticket's own fallback for this case.
  useEffect(() => {
    if (!open) return undefined;
    function onScroll() {
      closeNow();
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
  }, [open, closeNow]);

  // A resize can change both the rail's width (it's a resizable split pane) and the viewport's
  // clamping bounds, so the open card is kept in sync rather than left stale or closed outright.
  useEffect(() => {
    if (!open) return undefined;
    window.addEventListener('resize', reposition);
    return () => window.removeEventListener('resize', reposition);
  }, [open, reposition]);

  useEffect(() => clearTimers, [clearTimers]);

  function scheduleOpen() {
    if (!enabled) return;
    if (closeTimerRef.current !== undefined) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    }
    if (open || openTimerRef.current !== undefined) return;
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = undefined;
      reposition();
      claimSingleOpenSlot(closeNow);
      setOpen(true);
    }, OPEN_DELAY_MS);
  }

  function scheduleClose() {
    if (openTimerRef.current !== undefined) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = undefined;
    }
    if (!open || closeTimerRef.current !== undefined) return;
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = undefined;
      closeNow();
    }, CLOSE_DELAY_MS);
  }

  /** Keyboard focus opens the card immediately -- no 400ms delay, since a focus event is a
   *  deliberate keyboard action (Tab landing on the row), not something that fires dozens of
   *  times a second the way pointer movement does. */
  function onFocus() {
    if (!enabled) return;
    clearTimers();
    reposition();
    claimSingleOpenSlot(closeNow);
    setOpen(true);
  }

  return (
    <div
      ref={rowRef}
      onPointerEnter={scheduleOpen}
      onPointerLeave={scheduleClose}
      onFocus={onFocus}
      onBlur={closeNow}
    >
      {children}
      {open &&
        pos &&
        createPortal(
          <div
            role="tooltip"
            aria-label={`Console preview for ${guest.name}`}
            data-testid="guest-thumbnail-hover-card"
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: CARD_WIDTH_PX }}
            className={cn(
              'pointer-events-none z-50 overflow-hidden rounded-md border border-border bg-popover p-0 shadow-md',
            )}
          >
            <ConsoleThumbnail
              node={guest.node}
              type={guest.type}
              vmid={guest.vmid}
              name={guest.name}
              status={guest.status}
              template={guest.template}
              size="default"
              variant="hover"
            />
            <div className="truncate px-2 py-1 text-[11px] text-muted-foreground">
              {guest.name} · {guest.vmid}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
