import { Terminal } from '@/components/console/Terminal';
import type { NodeTabProps } from '@/pages/node/tabs';

/** Node shell tab: an xterm.js terminal against the node's own shell websocket. */
export function ShellTab({ node }: NodeTabProps) {
  return <Terminal node={node} />;
}
