import { useMemo, useState, type KeyboardEvent } from 'react';
import { Link, useLocation, useParams } from '@tanstack/react-router';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  ExternalLink,
  Folder,
  LayoutList,
  Server,
  Terminal,
} from 'lucide-react';
import { toast } from 'sonner';

import { Input } from '@/components/ui/input';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { StatusDot } from '@/components/StatusDot';
import { TagChip } from '@/components/TagChip';
import { EmptyState } from '@/components/EmptyState';
import { GuestContextMenu } from '@/components/actions/GuestContextMenu';
import { useClusterResources } from '@/api/hooks';
import { buildInventoryTree, filterTree, type GuestNode, type NodeNode } from '@/lib/tree';
import { cn } from '@/lib/utils';
import type { ClusterResource } from '@/api/types';

/** Copies a value to the clipboard with a toast -- `NodeRow`'s own "Copy name" action. Kept
 *  local (not shared with `GuestContextMenu.tsx`'s identical helper) so each file only exports
 *  components (React Fast Refresh's lint rule). */
function copyToClipboard(value: string, label: string) {
  navigator.clipboard
    ?.writeText(value)
    .then(() => toast.success(`Copied ${label}`))
    .catch(() => toast.error(`Could not copy ${label}`));
}

/**
 * Guest row layout -- "name first, whole chips only, fixed VMID gutter".
 *
 * Four grid tracks: status dot | name | tags | VMID.
 *
 *  - VMID is the last track at a FIXED 2.75rem, right-aligned mono, so every row's VMID shares
 *    one right edge no matter how many tags the row has.
 *  - The tags track is also FIXED, and its width is chosen by a container query on the rail --
 *    never by the row's own chip content. That is what stops a 3-tag row from stealing the
 *    name's width (or shoving the VMID track out of the row).
 *  - The name track is `minmax(0,1fr)`: it gets ALL the space the two fixed tracks don't use,
 *    which is what the old fixed 7rem tags column was eating (13 of 15 fixture names were
 *    truncated to ~5 characters).
 *
 * The rail breakpoint is 300px, with real slack under the shell's 340px default rail width (see
 * store/ui.ts) rather than sitting right at its edge. It used to be 319px -- one px under 320 --
 * to paper over `_shell.tsx` computing the rail as a percentage of a fixed 1440px reference
 * (so at any other viewport the rail's real pixel width drifted from `sidebarWidth`, and even
 * at 1440px a `ResizablePanelGroup` resize handle's own fixed width shaved a fraction of a
 * pixel off it) -- a single px of margin that a slightly different browser/zoom/DPI rounding
 * could still land the wrong side of. Now that `_shell.tsx` derives the rail's percentage from
 * the panel group's actual rendered width, the 340px default reliably renders at 340px, and 300
 * is just deliberate breathing room, not a rounding patch. Below the breakpoint the tags track
 * is 4rem and collapses to a single chip; at/above it the track is 7.25rem and shows two chips
 * plus a "+N" overflow chip. That width, and each chip's `px-0.5` padding (down from `TagChip`'s
 * own default `px-1` -- see TAG_CHIP below), are both deliberate: at the default `px-1` padding,
 * "prod"+"windows"+"+2" (win-dc01) needed 112.8px -- 0.8px more than even an 8rem (128px) track
 * would have given headroom for once the name column's needs were also accounted for -- so the
 * "+N" chip always wrapped out of view and silently hid the overflow count for any guest with
 * 3+ tags and a longish second tag. Tightening the padding first (measured need: win-dc01
 * 100.8px, "monitoring" -- prod;monitoring;alerts, the longest second-tag case -- 107.3px) means
 * a much smaller 7.25rem (116px) track clears every fixture guest with margin, instead of a
 * bigger track that would have come straight out of the name column's width.
 */
const GUEST_ROW_GRID = cn(
  'grid items-center gap-x-1.5',
  'grid-cols-[14px_minmax(0,1fr)_4rem_2.75rem]',
  '@min-[300px]:grid-cols-[14px_minmax(0,1fr)_7.25rem_2.75rem]',
);

/**
 * One clipped line of chips, right-aligned.
 *
 * `flex-wrap` + a one-chip-tall box + `overflow-hidden` is the no-partial-clipping trick: a chip
 * that does not fit on the line wraps to a second line that is clipped away entirely, so a chip
 * is either fully visible or not visible at all -- it is never sliced down the middle the way a
 * plain `overflow-hidden` nowrap strip slices the leading chip ("rod" for "prod").
 */
const TAG_STRIP =
  'flex h-4 min-w-0 flex-wrap content-start items-center justify-end gap-1 overflow-hidden';

/**
 * Chips never shrink (they wrap out of view instead) and never exceed the tags track.
 * `px-0.5` (not `TagChip`'s own default `px-1`) buys back ~4px per chip -- with 2-3 chips on a
 * line, that's the difference between "prod" + "windows" + "+2" fitting the wide tags track and
 * silently wrapping the "+N" overflow chip out of view (see GUEST_ROW_GRID's comment).
 */
const TAG_CHIP = 'max-w-full shrink-0 px-0.5';

const COUNT_CHIP = cn(
  'inline-flex h-4 max-w-full shrink-0 items-center rounded-sm border border-border px-0.5',
  'text-[10px] leading-none whitespace-nowrap text-muted-foreground',
);

/**
 * Tags for one guest row. Both the narrow and the wide arrangement are rendered and swapped by
 * the rail container query, so the choice costs no measurement and no layout thrash:
 *
 *  - rail < 300px: a single chip -- the tag itself when there is exactly one, otherwise an
 *    "N tags" summary chip.
 *  - rail >= 300px (the shell's 340px default rail comfortably clears this -- see
 *    GUEST_ROW_GRID's comment above): the first two tags plus a "+N" chip for the rest.
 *
 * The complete tag list is always reachable as a tooltip on the strip.
 */
function GuestTags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return <span />;
  const [first, second, ...rest] = tags;
  const fullList = tags.join(', ');

  return (
    <span className="min-w-0" title={fullList}>
      <span className={cn(TAG_STRIP, '@min-[300px]:hidden')}>
        {tags.length === 1 ? (
          <TagChip tag={first!} className={TAG_CHIP} />
        ) : (
          <span className={COUNT_CHIP}>{tags.length} tags</span>
        )}
      </span>
      <span className={cn(TAG_STRIP, 'hidden @min-[300px]:flex')}>
        <TagChip tag={first!} className={TAG_CHIP} />
        {second !== undefined && <TagChip tag={second} className={TAG_CHIP} />}
        {rest.length > 0 && <span className={COUNT_CHIP}>+{rest.length}</span>}
      </span>
    </span>
  );
}

function GuestRow({ guest }: { guest: GuestNode }) {
  const params = useParams({ strict: false });
  const isActive = String(params.vmid) === String(guest.vmid) && params.node === guest.node;

  return (
    <GuestContextMenu guest={guest}>
      <Link
        to="/vm/$node/$type/$vmid"
        params={{ node: guest.node, type: guest.type, vmid: String(guest.vmid) }}
        search={{ tab: 'summary' }}
        className={cn(
          GUEST_ROW_GRID,
          'w-full rounded-md py-1 pr-1.5 pl-7 text-left text-sm outline-none',
          'hover:bg-accent/10 focus-visible:bg-accent/10',
          isActive && 'bg-accent/15 text-foreground',
        )}
      >
        <StatusDot status={guest.status} template={guest.template} />
        <span className="min-w-0 truncate" title={guest.name}>
          {guest.name}
        </span>
        <GuestTags tags={guest.tags} />
        <span
          data-testid="guest-vmid"
          className="text-right text-[11px] text-muted-foreground font-numeric"
        >
          {guest.vmid}
        </span>
      </Link>
    </GuestContextMenu>
  );
}

/**
 * A node row: the NAME navigates to the node's Summary tab (like a guest row); the chevron is a
 * separate control that only toggles the subtree, so it never fights the name for what a click
 * does. It still carries the same context menu affordance guests have (right-click, Shift+F10
 * and the context-menu key all emit the native `contextmenu` event the trigger listens for) --
 * "Open" there is a second way to reach the node page from the tree, alongside the name link.
 */
function NodeRow({
  node,
  collapsed,
  onToggle,
}: {
  node: NodeNode;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const params = useParams({ strict: false });
  const isActive = params.node === node.name && params.vmid === undefined;

  // Only ArrowLeft/ArrowRight need a handler here: Space and Enter already toggle a native
  // <button> without one.
  function onChevronKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      onToggle();
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'flex w-full items-center gap-1 rounded-md py-1 pr-1.5 pl-1 text-sm font-medium',
            'hover:bg-accent/10',
            isActive && 'bg-accent/15 text-foreground',
          )}
        >
          <button
            type="button"
            onClick={onToggle}
            onKeyDown={onChevronKeyDown}
            aria-label={collapsed ? `Expand ${node.name}` : `Collapse ${node.name}`}
            aria-expanded={!collapsed}
            className="shrink-0 rounded p-0.5 outline-none hover:bg-accent/20 focus-visible:bg-accent/20"
          >
            {collapsed ? (
              <ChevronRight className="size-3.5 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-3.5 text-muted-foreground" />
            )}
          </button>
          <StatusDot status={node.status} />
          <Link
            to="/node/$node"
            params={{ node: node.name }}
            search={{ tab: 'summary' }}
            className="min-w-0 flex-1 truncate rounded px-0.5 outline-none hover:underline focus-visible:bg-accent/10"
          >
            {node.name}
          </Link>
          <span className="text-xs text-muted-foreground">{node.children.length}</span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem asChild>
          <Link to="/node/$node" params={{ node: node.name }} search={{ tab: 'summary' }}>
            <ExternalLink /> Open
          </Link>
        </ContextMenuItem>
        <ContextMenuItem asChild>
          <Link to="/node/$node" params={{ node: node.name }} search={{ tab: 'shell' }}>
            <Terminal /> Open shell
          </Link>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => copyToClipboard(node.name, 'name')}>
          <Copy /> Copy name
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function StorageRow({ storage, node }: { storage: ClusterResource; node: string }) {
  const used = storage.disk ?? 0;
  const total = storage.maxdisk ?? 0;
  const pct = total > 0 ? Math.min(1, used / total) : 0;
  const Icon = storage.plugintype === 'dir' ? Folder : Database;

  return (
    <Link
      to="/node/$node"
      params={{ node }}
      search={{ tab: 'storage' }}
      className="grid w-full grid-cols-[14px_minmax(0,1fr)_4.5rem] items-center gap-x-1.5 rounded-md py-1 pr-1.5 pl-7 text-left text-xs outline-none hover:bg-accent/10 focus-visible:bg-accent/10"
    >
      <Icon className="size-3 text-muted-foreground" />
      <span className="min-w-0 truncate">{storage.storage}</span>
      <span className="flex items-center justify-end gap-1.5">
        <span className="h-1 w-8 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <span
            className="block h-full rounded-full bg-accent"
            style={{ width: `${pct * 100}%` }}
          />
        </span>
        <span className="w-8 text-right text-[10px] text-muted-foreground font-numeric">
          {Math.round(pct * 100)}%
        </span>
      </span>
    </Link>
  );
}

function StorageGroup({
  nodeName,
  resources,
  collapsed,
  onToggle,
}: {
  nodeName: string;
  resources: ClusterResource[];
  collapsed: boolean;
  onToggle: () => void;
}) {
  const storages = resources.filter((r) => r.type === 'storage' && r.node === nodeName);
  if (storages.length === 0) return null;

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1.5 rounded-md py-1 pr-1.5 pl-5 text-left text-xs font-medium text-muted-foreground hover:bg-accent/10 focus-visible:bg-accent/10"
      >
        {collapsed ? (
          <ChevronRight className="size-3 shrink-0" />
        ) : (
          <ChevronDown className="size-3 shrink-0" />
        )}
        <span className="flex-1">Storage</span>
        <span>{storages.length}</span>
      </button>
      {!collapsed && storages.map((s) => <StorageRow key={s.id} storage={s} node={nodeName} />)}
    </div>
  );
}

/**
 * "Guests" nav entry, pinned above the Datacenter tree: a vSphere-style cluster-wide guest list
 * at `/guests` (`pages/guests/GuestsPage.tsx`), one level up from any single node's guests. A
 * plain `<Link>` -- keyboard-reachable and active-styled the same way `NodeRow`'s own name link
 * is -- rather than a tree row, since it has no children to expand/collapse.
 */
function GuestsNavEntry() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const isActive = pathname === '/guests';

  return (
    <Link
      to="/guests"
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium outline-none',
        'hover:bg-accent/10 focus-visible:bg-accent/10',
        isActive && 'bg-accent/15 text-foreground',
      )}
    >
      <LayoutList className="size-3.5 text-muted-foreground" />
      Guests
    </Link>
  );
}

export function InventoryTree() {
  const { data: resources, isLoading } = useClusterResources();
  const [query, setQuery] = useState('');
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());

  const tree = useMemo(() => {
    if (!resources) return null;
    const full = buildInventoryTree(resources);
    return filterTree(full, query);
  }, [resources, query]);

  const toggleNode = (id: string) => {
    setCollapsedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    // `@container` makes the rail itself the query container the guest rows adapt to.
    <div className="@container flex h-full flex-col">
      <div className="border-b border-border p-2">
        <GuestsNavEntry />
      </div>
      <div className="border-b border-border p-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name, VMID or tag"
          aria-label="Filter inventory"
          className="h-7 text-xs"
        />
      </div>
      <div role="tree" aria-label="Inventory" className="flex-1 overflow-y-auto py-1">
        {isLoading || !tree ? (
          <div className="space-y-2 p-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="h-5 animate-pulse rounded bg-muted motion-reduce:animate-none"
              />
            ))}
          </div>
        ) : tree.children.length === 0 ? (
          <EmptyState message="No matches." />
        ) : (
          <div>
            <Link
              to="/"
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase outline-none hover:bg-accent/10 hover:text-foreground focus-visible:bg-accent/10"
            >
              <Server className="size-3.5" /> {tree.name}
            </Link>
            {tree.children.map((node) => {
              const collapsed = collapsedNodes.has(node.id);
              return (
                <div key={node.id} role="treeitem" aria-expanded={!collapsed}>
                  <NodeRow node={node} collapsed={collapsed} onToggle={() => toggleNode(node.id)} />
                  {!collapsed && (
                    <div>
                      {node.children.length === 0 ? (
                        <EmptyState message="No guests." />
                      ) : (
                        node.children.map((guest) => <GuestRow key={guest.id} guest={guest} />)
                      )}
                      <StorageGroup
                        nodeName={node.name}
                        resources={resources ?? []}
                        collapsed={collapsedNodes.has(`${node.id}::storage`)}
                        onToggle={() => toggleNode(`${node.id}::storage`)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
