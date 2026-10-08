import type { NodeNetIface } from '@/api/nodeNetwork';

export type NetCreateKind = 'bridge' | 'bond' | 'vlan';

export const NET_KIND_LABEL: Record<NetCreateKind, string> = {
  bridge: 'Linux Bridge',
  bond: 'Linux Bond',
  vlan: 'Linux VLAN',
};

export type NetIfaceDialogMode = { kind: 'create'; type: NetCreateKind } | { kind: 'edit'; iface: NodeNetIface };
