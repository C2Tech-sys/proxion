import type { ComponentType } from 'react';

import { EmptyState } from '@/components/EmptyState';
import type { VmTabProps } from '@/pages/vm/tabs';

/** Placeholder until the Firewall tab ships; the tab registry already points here. */
export const FirewallTab: ComponentType<VmTabProps> = () => (
  <div data-testid="firewall-tab">
    <EmptyState message="Coming soon." />
  </div>
);

export default FirewallTab;
