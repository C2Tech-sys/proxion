import { Dialog, DialogContent } from '@/components/ui/dialog';
import { CtWizard } from '@/components/create/ct/CtWizard';
import { useCreateStore } from '@/store/createStore';

/**
 * "Create container" wizard: General, Template, Disks, CPU, Memory, Network, DNS, Confirm. Mounted
 * once in the app shell; opens whenever `useCreateStore.open.kind === 'lxc'`. The wizard body lives
 * in `ct/CtWizard.tsx` and is mounted fresh on each open (Radix unmounts the content when closed).
 */
export function CreateCtDialog() {
  const open = useCreateStore((s) => s.open);
  const closeCreate = useCreateStore((s) => s.closeCreate);
  const isOpen = open?.kind === 'lxc';

  return (
    <Dialog open={isOpen} onOpenChange={(next) => !next && closeCreate()}>
      <DialogContent data-testid="create-ct-dialog" className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <CtWizard initialNode={open?.node} onClose={closeCreate} />
      </DialogContent>
    </Dialog>
  );
}
