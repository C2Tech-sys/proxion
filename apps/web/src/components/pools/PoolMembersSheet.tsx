import { useId, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useClusterResources } from '@/api/hooks';
import { useUpdatePool } from '@/api/poolsHooks';
import type { Pool, PoolMember } from '@/api/pools';

export interface PoolMembersSheetProps {
  /** The pool to manage, or `null` to keep the sheet closed. */
  pool: Pool | null;
  /** Every pool, to tell which pool a candidate guest already belongs to. */
  pools: Pool[];
  /** When set, every change control is disabled and this is its tooltip. */
  disabledReason?: string | undefined;
  onOpenChange: (open: boolean) => void;
}

function memberLabel(member: PoolMember, names: Map<number, string>): string {
  if (member.type === 'storage') return `Storage ${member.storage ?? member.id} (${member.node})`;
  const name = member.vmid !== undefined ? names.get(member.vmid) : undefined;
  return `${member.type === 'lxc' ? 'CT' : 'VM'} ${member.vmid ?? ''}${name ? ` ${name}` : ''} (${member.node})`;
}

/**
 * A right-hand sheet listing a pool's members (guests and storages) with checkboxes to remove
 * them, and two pickers to add guests or storages from the cluster. A guest that already belongs
 * to another pool is marked and, if chosen, added with `allow-move` (PVE otherwise refuses it).
 * Each action is one request to `PUT /api/actions/datacenter/pools/:poolid`; adding and removing
 * are separate requests because PVE takes one `delete` flag per call.
 */
export function PoolMembersSheet({ pool, pools, disabledReason, onOpenChange }: PoolMembersSheetProps) {
  const id = useId();
  const resources = useClusterResources();
  const mutation = useUpdatePool();
  const [removeSelection, setRemoveSelection] = useState<string[]>([]);
  const [guestSelection, setGuestSelection] = useState<number[]>([]);
  const [storageSelection, setStorageSelection] = useState<string[]>([]);
  const [filter, setFilter] = useState('');

  const names = useMemo(() => {
    const map = new Map<number, string>();
    for (const r of resources.data ?? []) {
      if (r.vmid !== undefined && r.name) map.set(r.vmid, r.name);
    }
    return map;
  }, [resources.data]);

  const poolOfGuest = useMemo(() => {
    const map = new Map<number, string>();
    for (const p of pools) {
      for (const m of p.members) if (m.vmid !== undefined) map.set(m.vmid, p.poolid);
    }
    return map;
  }, [pools]);

  const needle = filter.trim().toLowerCase();

  const guestCandidates = useMemo(() => {
    const seen = new Set<number>();
    const memberIds = new Set(pool?.members.map((m) => m.id));
    return (resources.data ?? [])
      .filter((r) => (r.type === 'qemu' || r.type === 'lxc') && r.vmid !== undefined)
      .filter((r) => {
        if (seen.has(r.vmid!)) return false;
        seen.add(r.vmid!);
        return true;
      })
      .filter((r) => !memberIds.has(`${r.type}/${r.vmid}`))
      .filter((r) => needle === '' || `${r.vmid} ${r.name ?? ''}`.toLowerCase().includes(needle))
      .sort((a, b) => (a.vmid ?? 0) - (b.vmid ?? 0));
  }, [resources.data, pool, needle]);

  const storageCandidates = useMemo(() => {
    const ids = new Set<string>();
    for (const r of resources.data ?? []) if (r.type === 'storage' && r.storage) ids.add(r.storage);
    const inPool = new Set(pool?.members.filter((m) => m.type === 'storage').map((m) => m.storage));
    return [...ids]
      .filter((s) => !inPool.has(s))
      .filter((s) => needle === '' || s.toLowerCase().includes(needle))
      .sort((a, b) => a.localeCompare(b));
  }, [resources.data, pool, needle]);

  const busy = mutation.isPending;
  const locked = disabledReason !== undefined || busy;

  function removeSelected() {
    if (!pool || removeSelection.length === 0) return;
    const chosen = pool.members.filter((m) => removeSelection.includes(m.id));
    const vms = chosen.filter((m) => m.type !== 'storage' && m.vmid !== undefined).map((m) => m.vmid!);
    const storage = chosen.filter((m) => m.type === 'storage' && m.storage !== undefined).map((m) => m.storage!);
    mutation.mutate(
      {
        poolid: pool.poolid,
        body: { ...(vms.length > 0 ? { vms } : {}), ...(storage.length > 0 ? { storage } : {}), remove: true },
      },
      { onSuccess: () => setRemoveSelection([]) },
    );
  }

  function addGuests() {
    if (!pool || guestSelection.length === 0) return;
    const moving = guestSelection.some((vmid) => poolOfGuest.has(vmid));
    mutation.mutate(
      { poolid: pool.poolid, body: { vms: guestSelection, ...(moving ? { 'allow-move': true } : {}) } },
      { onSuccess: () => setGuestSelection([]) },
    );
  }

  function addStorages() {
    if (!pool || storageSelection.length === 0) return;
    mutation.mutate({ poolid: pool.poolid, body: { storage: storageSelection } }, { onSuccess: () => setStorageSelection([]) });
  }

  return (
    <Sheet open={pool !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Pool members: {pool?.poolid ?? ''}</SheetTitle>
          <SheetDescription>
            Guests and storages in this pool. Adding a guest that is in another pool moves it here.
          </SheetDescription>
        </SheetHeader>

        {pool && (
          <div className="flex flex-col gap-5 px-4 pb-4">
            {mutation.isError && (
              <p role="alert" className="text-xs text-status-error">
                {hardwareErrorMessage(mutation.error, 'The pool could not be changed.')}
              </p>
            )}

            <section className="flex flex-col gap-2" aria-label="Current members">
              <h3 className="text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase">
                Members ({pool.members.length})
              </h3>
              {pool.members.length === 0 ? (
                <p className="text-sm text-muted-foreground">This pool has no members.</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {pool.members.map((member) => (
                    <li key={member.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`${id}-m-${member.id}`}
                        aria-label={`Select ${memberLabel(member, names)}`}
                        checked={removeSelection.includes(member.id)}
                        disabled={locked}
                        onCheckedChange={(checked) =>
                          setRemoveSelection((current) =>
                            checked === true ? [...current, member.id] : current.filter((m) => m !== member.id),
                          )
                        }
                      />
                      <label htmlFor={`${id}-m-${member.id}`} className="text-sm">
                        {memberLabel(member, names)}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={locked || removeSelection.length === 0}
                  title={disabledReason}
                  onClick={removeSelected}
                >
                  {busy && <Loader2 className="size-3.5 animate-spin" />}
                  Remove selected ({removeSelection.length})
                </Button>
              </div>
            </section>

            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-filter`} className="text-sm font-medium">
                Filter candidates
              </label>
              <Input id={`${id}-filter`} value={filter} autoComplete="off" onChange={(e) => setFilter(e.target.value)} />
            </div>

            <section className="flex flex-col gap-2" aria-label="Add guests">
              <h3 className="text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase">Add guests</h3>
              {guestCandidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">No guests to add.</p>
              ) : (
                <ul className="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
                  {guestCandidates.map((guest) => {
                    const other = poolOfGuest.get(guest.vmid!);
                    const label = `${guest.type === 'lxc' ? 'CT' : 'VM'} ${guest.vmid} ${guest.name ?? ''}`.trim();
                    return (
                      <li key={guest.vmid} className="flex items-center gap-2">
                        <Checkbox
                          id={`${id}-g-${guest.vmid}`}
                          aria-label={`Add ${label}`}
                          checked={guestSelection.includes(guest.vmid!)}
                          disabled={locked}
                          onCheckedChange={(checked) =>
                            setGuestSelection((current) =>
                              checked === true ? [...current, guest.vmid!] : current.filter((v) => v !== guest.vmid),
                            )
                          }
                        />
                        <label htmlFor={`${id}-g-${guest.vmid}`} className="text-sm">
                          {label} ({guest.node})
                          {other !== undefined && <span className="text-muted-foreground"> - in pool {other}</span>}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div>
                <Button size="sm" disabled={locked || guestSelection.length === 0} title={disabledReason} onClick={addGuests}>
                  Add selected guests ({guestSelection.length})
                </Button>
              </div>
            </section>

            <section className="flex flex-col gap-2" aria-label="Add storages">
              <h3 className="text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase">Add storages</h3>
              {storageCandidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">No storages to add.</p>
              ) : (
                <ul className="flex max-h-40 flex-col gap-1.5 overflow-y-auto">
                  {storageCandidates.map((storage) => (
                    <li key={storage} className="flex items-center gap-2">
                      <Checkbox
                        id={`${id}-s-${storage}`}
                        aria-label={`Add storage ${storage}`}
                        checked={storageSelection.includes(storage)}
                        disabled={locked}
                        onCheckedChange={(checked) =>
                          setStorageSelection((current) =>
                            checked === true ? [...current, storage] : current.filter((s) => s !== storage),
                          )
                        }
                      />
                      <label htmlFor={`${id}-s-${storage}`} className="text-sm">
                        {storage}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <div>
                <Button
                  size="sm"
                  disabled={locked || storageSelection.length === 0}
                  title={disabledReason}
                  onClick={addStorages}
                >
                  Add selected storages ({storageSelection.length})
                </Button>
              </div>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
