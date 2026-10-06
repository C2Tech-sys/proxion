import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCreateStore } from '@/store/createStore';

/**
 * "Create container" -- scaffold only (the wizard lands in a follow-up). Mounted once in the app
 * shell; opens whenever `useCreateStore.open.kind === 'lxc'`.
 */
export function CreateCtDialog() {
  const open = useCreateStore((s) => s.open);
  const closeCreate = useCreateStore((s) => s.closeCreate);
  const isOpen = open?.kind === 'lxc';

  return (
    <Dialog open={isOpen} onOpenChange={(next) => !next && closeCreate()}>
      <DialogContent data-testid="create-ct-dialog">
        <DialogHeader>
          <DialogTitle>Create container</DialogTitle>
          <DialogDescription>
            {open?.node ? `Node: ${open.node}` : 'No node selected yet.'}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">Coming soon.</p>
        <DialogFooter>
          <Button variant="outline" onClick={closeCreate}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
