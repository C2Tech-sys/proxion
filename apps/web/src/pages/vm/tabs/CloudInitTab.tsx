import type { ComponentType } from 'react';

import { EmptyState } from '@/components/EmptyState';
import type { VmTabProps } from '@/pages/vm/tabs';

/** Placeholder until the Cloud-Init tab ships; the tab registry already points here. */
export const CloudInitTab: ComponentType<VmTabProps> = () => (
  <div data-testid="cloudinit-tab">
    <EmptyState message="Coming soon." />
  </div>
);

export default CloudInitTab;
