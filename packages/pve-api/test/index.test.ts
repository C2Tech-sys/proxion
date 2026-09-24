import { describe, expect, it } from 'vitest';
import { PveClient, PveHttp, isQemu, isLxc, isNode, type ClusterResource } from '../src/index.js';

describe('@proxion/pve-api', () => {
  it('exports the client, transport and curated helpers', () => {
    expect(typeof PveClient).toBe('function');
    expect(typeof PveHttp).toBe('function');
    expect(typeof isQemu).toBe('function');
    expect(typeof isLxc).toBe('function');
    expect(typeof isNode).toBe('function');
  });

  it('discriminates cluster resources by type', () => {
    const resources: ClusterResource[] = [
      { type: 'node', id: 'node/pve', node: 'pve', status: 'online' },
      { type: 'qemu', id: 'qemu/100', vmid: 100, node: 'pve', status: 'running' },
      { type: 'lxc', id: 'lxc/101', vmid: 101, node: 'pve', status: 'stopped' },
    ];

    expect(resources.filter(isNode)).toHaveLength(1);
    expect(resources.filter(isQemu)).toHaveLength(1);
    expect(resources.filter(isLxc)).toHaveLength(1);
  });

  it('constructs a client wrapping a PveHttp transport', () => {
    const http = new PveHttp({
      baseUrl: 'https://pve.example.com:8006',
      credentials: { type: 'token', tokenId: 'root@pam!test', tokenSecret: 'secret' },
    });
    const client = new PveClient(http);
    expect(typeof client.get).toBe('function');
    expect(typeof client.raw).toBe('function');
  });
});
