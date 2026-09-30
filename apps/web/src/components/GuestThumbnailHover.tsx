import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { ConsoleThumbnail } from '@/components/ConsoleThumbnail';
import { usePrefs } from '@/api/prefsHooks';
import type { GuestNode } from '@/lib/tree';
import { cn } from '@/lib/utils';

const OPEN_DELAY_MS = 400;
const CLOSE_DELAY_MS = 150;
const CARD_WIDTH_PX = 240;

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
  /** The trigger row -- a single element (the guest row's `Link`) this wraps in a plain
   *  positioning `<div>`, so the floating card can be placed at `left: 100%` of it. */
  children: ReactElement;
}

/**
 * Wraps one inventory-tree guest row with a floating console-preview card: pointer hover (after
 * a 400ms open delay, so scanning down the rail doesn't fire a fetch per row it passes over) or
 * keyboard focus shows a compact `ConsoleThumbnail` plus a "name · vmid" caption to the right of
 * the row. Closes 150ms after the pointer leaves both the row and the card itself (so crossing
 * the gap between them doesn't flicker it shut), immediately on blur, and immediately if the
 * rail scrolls out from under it.
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
  useEffect(() => {
    if (!open) return undefined;
    function onScroll() {
      closeNow();
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
  }, [open, closeNow]);

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
    claimSingleOpenSlot(closeNow);
    setOpen(true);
  }

  return (
    <div
      className="relative"
      onPointerEnter={scheduleOpen}
      onPointerLeave={scheduleClose}
      onFocus={onFocus}
      onBlur={closeNow}
    >
      {children}
      {open && (
        <div
          role="tooltip"
          aria-label={`Console preview for ${guest.name}`}
          data-testid="guest-thumbnail-hover-card"
          onPointerEnter={() => {
            if (closeTimerRef.current !== undefined) {
              clearTimeout(closeTimerRef.current);
              closeTimerRef.current = undefined;
            }
          }}
          onPointerLeave={scheduleClose}
          style={{ width: CARD_WIDTH_PX }}
          className={cn(
            'absolute top-0 left-full z-50 ml-1.5 overflow-hidden rounded-md border border-border bg-popover p-0 shadow-md',
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
        </div>
      )}
    </div>
  );
}
