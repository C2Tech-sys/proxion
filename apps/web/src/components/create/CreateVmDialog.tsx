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
 * "Create virtual machine" -- scaffold only (the wizard lands in a follow-up). Mounted once in the
 * app shell; opens whenever `useCreateStore.open.kind === 'qemu'`.
 */
export function CreateVmDialog() {
  const open = useCreateStore((s) => s.open);
  const closeCreate = useCreateStore((s) => s.closeCreate);
  const isOpen = open?.kind === 'qemu';

  return (
    <Dialog open={isOpen} onOpenChange={(next) => !next && closeCreate()}>
      <DialogContent data-testid="create-vm-dialog">
        <DialogHeader>
          <DialogTitle>Create virtual machine</DialogTitle>
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
