import type { ComponentType } from 'react';

import { DashboardPage } from '@/pages/dashboard/DashboardPage';
import { BackupJobsTab } from '@/pages/datacenter/tabs/BackupJobsTab';
import { ClusterFirewallTab } from '@/pages/datacenter/tabs/ClusterFirewallTab';
import { UsersTab } from '@/pages/datacenter/tabs/UsersTab';
import { StorageConfigTab } from '@/pages/datacenter/tabs/StorageConfigTab';
import { PoolsTab } from '@/pages/datacenter/tabs/PoolsTab';

export const DATACENTER_TAB_ORDER = [
  'overview',
  'backup',
  'firewall',
  'users',
  'storage',
  'pools',
] as const;
export type DatacenterTab = (typeof DATACENTER_TAB_ORDER)[number];

export function isDatacenterTab(value: unknown): value is DatacenterTab {
  return typeof value === 'string' && (DATACENTER_TAB_ORDER as readonly string[]).includes(value);
}

/** tab search-param value -> { label, component }, in display order. Datacenter tabs are
 *  cluster-wide, so (unlike the node/VM tabs) they take no props. The Overview tab is the
 *  existing dashboard, rendered as-is. */
export const DATACENTER_TAB_REGISTRY: Record<DatacenterTab, { label: string; component: ComponentType }> = {
  overview: { label: 'Overview', component: DashboardPage },
  backup: { label: 'Backup Jobs', component: BackupJobsTab },
  firewall: { label: 'Firewall', component: ClusterFirewallTab },
  users: { label: 'Users & Permissions', component: UsersTab },
  storage: { label: 'Storage', component: StorageConfigTab },
  pools: { label: 'Pools', component: PoolsTab },
};
