/**
 * Shared sizing for console/terminal surfaces (VncConsole, Terminal). The object-page tab
 * body now carries a definite height all the way down (the shell's main area, the object
 * page root, `<Tabs>` and the active `<TabsContent>` are all `flex-1 min-h-0` links in one
 * flex chain -- see `_shell.tsx`, `vm.$node.$type.$vmid.tsx` and `node.$node.tsx`), so a
 * console can simply fill it with `h-full` instead of guessing a viewport-relative height.
 * The old `h-[calc(100svh-13rem)]` was a fixed estimate of the chrome above the tab body
 * (top bar, object header, tab strip) that drifted from the real layout and, worse, was
 * unrelated to the tasks drawer's height, so the console's bottom edge didn't track it.
 */
export const CONSOLE_SURFACE_HEIGHT_CLASS = 'h-full min-h-[360px]';
