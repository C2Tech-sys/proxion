import type { ComponentType } from 'react';

import { EmptyState } from '@/components/EmptyState';
import type { VmTabProps } from '@/pages/vm/tabs';

/** Placeholder until the Options tab ships; the tab registry already points here. */
export const OptionsTab: ComponentType<VmTabProps> = () => (
  <div data-testid="options-tab">
    <EmptyState message="Coming soon." />
  </div>
);

export default OptionsTab;
