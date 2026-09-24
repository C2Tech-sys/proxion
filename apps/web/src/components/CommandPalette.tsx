import { useEffect, useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Box, Container, HardDrive, Server } from 'lucide-react';

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useClusterResources } from '@/api/hooks';
import { useUiStore } from '@/store/ui';
import { toSearchItems, type FlatSearchItem } from '@/lib/tree';
import { isHotkeyScopeSuppressed } from '@/lib/hotkeys';

function iconFor(item: FlatSearchItem) {
  if (item.kind === 'node') return Server;
  if (item.kind === 'storage') return HardDrive;
  return item.type === 'lxc' ? Container : Box;
}

/** Global Cmd/Ctrl-K command palette: search nodes, VMs, CTs and storage from fixtures. */
export function CommandPalette() {
  const open = useUiStore((s) => s.commandPaletteOpen);
  const setOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const { data: resources } = useClusterResources();
  const navigate = useNavigate();

  const items = useMemo(() => toSearchItems(resources ?? []), [resources]);
  const grouped = useMemo(
    () => ({
      node: items.filter((i) => i.kind === 'node'),
      guest: items.filter((i) => i.kind === 'guest'),
      storage: items.filter((i) => i.kind === 'storage'),
    }),
    [items],
  );

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        // A focused console/terminal owns the keyboard (the guest may itself use Ctrl-K).
        if (isHotkeyScopeSuppressed(e.target)) return;
        e.preventDefault();
        setOpen(!open);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, setOpen]);

  function select(item: FlatSearchItem) {
    setOpen(false);
    if (item.kind === 'guest' && item.type && item.vmid !== undefined) {
      void navigate({
        to: '/vm/$node/$type/$vmid',
        params: { node: item.node, type: item.type as 'qemu' | 'lxc', vmid: String(item.vmid) },
        search: { tab: 'summary' },
      });
    } else if (item.kind === 'storage') {
      void navigate({ to: '/node/$node', params: { node: item.node }, search: { tab: 'storage' } });
    } else {
      void navigate({ to: '/node/$node', params: { node: item.node }, search: { tab: 'summary' } });
    }
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search nodes, VMs, containers, storage&hellip;" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        {grouped.node.length > 0 && (
          <CommandGroup heading="Nodes">
            {grouped.node.map((item) => {
              const Icon = iconFor(item);
              return (
                <CommandItem key={item.id} value={`${item.label} ${item.sublabel}`} onSelect={() => select(item)}>
                  <Icon /> {item.label}
                  <span className="ml-auto text-xs text-muted-foreground">{item.sublabel}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
        {grouped.guest.length > 0 && (
          <CommandGroup heading="VMs & Containers">
            {grouped.guest.map((item) => {
              const Icon = iconFor(item);
              return (
                <CommandItem
                  key={item.id}
                  value={`${item.label} ${item.sublabel} ${item.vmid}`}
                  onSelect={() => select(item)}
                >
                  <Icon /> {item.label}
                  <span className="ml-auto text-xs text-muted-foreground">{item.sublabel}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
        {grouped.storage.length > 0 && (
          <CommandGroup heading="Storage">
            {grouped.storage.map((item) => {
              const Icon = iconFor(item);
              return (
                <CommandItem key={item.id} value={`${item.label} ${item.sublabel}`} onSelect={() => select(item)}>
                  <Icon /> {item.label}
                  <span className="ml-auto text-xs text-muted-foreground">{item.sublabel}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
