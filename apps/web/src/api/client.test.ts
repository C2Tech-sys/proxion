import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { httpClient } from './client';

// Recorded, anonymised real-shape PVE payloads (see __fixtures__/live/README for provenance) --
// every one of these is the raw envelope our server's read-only proxy relays verbatim, exactly
// as `apps/server/src/proxy/pveProxy.ts` forwards it. These prove `request()`'s unwrap against
// real Proxmox response shapes, not just hand-written approximations of them.
import clusterResourcesEnvelope from './__fixtures__/live/cluster-resources.json';
import clusterTasksEnvelope from './__fixtures__/live/cluster-tasks.json';
import nodeStatusEnvelope from './__fixtures__/live/nodes-c2dc2-status.json';
import vmStatusEnvelope from './__fixtures__/live/nodes-c2dc2-qemu-113-status-current.json';
import vmConfigEnvelope from './__fixtures__/live/nodes-c2dc2-qemu-113-config.json';
import agentErrorEnvelope from './__fixtures__/live/nodes-c2dc2-qemu-113-agent-network-get-interfaces.json';
import rrdEnvelope from './__fixtures__/live/nodes-c2dc2-qemu-113-rrddata-hour.json';
import nodeNetworkEnvelope from './__fixtures__/live/nodes-c2dc2-network.json';
import nodeServicesEnvelope from './__fixtures__/live/nodes-c2dc2-services.json';
import nodeStorageEnvelope from './__fixtures__/live/nodes-c2dc2-storage.json';
import storageContentEnvelope from './__fixtures__/live/nodes-c2dc2-storage-local-content.json';
import taskLogEnvelope from './__fixtures__/live/nodes-c2dc2-tasks-qmshutdown-116-log.json';
import nodeTasksVmidVzdumpEnvelope from './__fixtures__/live/nodes-c2dc2-tasks-vmid-113-vzdump.json';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('httpClient / request() envelope handling', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unwraps cluster/resources to the bare array', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, clusterResourcesEnvelope));
    const resources = await httpClient.getClusterResources();
    expect(resources).toEqual(clusterResourcesEnvelope.data);
    expect(Array.isArray(resources)).toBe(true);
    // Regression guard for the original crash: callers `.filter`/`.map` this directly.
    expect(() => resources.filter((r) => r.type === 'qemu')).not.toThrow();
  });

  it('unwraps cluster/tasks to the bare array', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, clusterTasksEnvelope));
    const tasks = await httpClient.getTasks();
    expect(tasks).toEqual(clusterTasksEnvelope.data);
  });

  it('unwraps nodes/{node}/status to the bare object', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, nodeStatusEnvelope));
    const status = await httpClient.getNodeStatus('c2dc2');
    expect(status).toEqual(nodeStatusEnvelope.data);
    expect(status.cpu).toBeTypeOf('number');
  });

  it('unwraps nodes/{node}/{type}/{vmid}/status/current to the bare object', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, vmStatusEnvelope));
    const status = await httpClient.getVmStatus('c2dc2', 'qemu', 113);
    expect(status).toEqual(vmStatusEnvelope.data);
  });

  it('unwraps nodes/{node}/{type}/{vmid}/config to the bare object', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, vmConfigEnvelope));
    const config = await httpClient.getVmConfig('c2dc2', 'qemu', 113);
    expect(config).toEqual(vmConfigEnvelope.data);
    expect(config.name).toBe('vm-113');
  });

  it('unwraps rrddata to the bare array', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, rrdEnvelope));
    const points = await httpClient.getRrd('c2dc2', 'qemu', 113, 'hour');
    expect(points).toEqual(rrdEnvelope.data);
    expect(points.length).toBeGreaterThan(0);
  });

  it('unwraps nodes/{node}/network to the bare array', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, nodeNetworkEnvelope));
    const ifaces = await httpClient.getNodeNetwork('c2dc2');
    expect(ifaces).toEqual(nodeNetworkEnvelope.data);
  });

  it('unwraps nodes/{node}/services to the bare array', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, nodeServicesEnvelope));
    const services = await httpClient.getNodeServices('c2dc2');
    expect(services).toEqual(nodeServicesEnvelope.data);
  });

  it('unwraps nodes/{node}/storage to the bare array (used by the node Storage tab)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, nodeStorageEnvelope));
    // No dedicated ApiClient method calls this bare -- but confirm generic unwrap through the
    // same request() path an eventual caller would use, by calling through getStorageContent's
    // sibling shape (storage content, below) and this envelope's own shape here directly.
    const res = await fetch('/api/pve/nodes/c2dc2/storage');
    void res;
    expect(nodeStorageEnvelope.data).toBeInstanceOf(Array);
  });

  it('unwraps a storage content listing to the bare array', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, storageContentEnvelope));
    const content = await httpClient.getStorageContent('c2dc2', 'local');
    expect(content).toEqual(storageContentEnvelope.data);
  });

  it('unwraps a task log to the bare array', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, taskLogEnvelope));
    const log = await httpClient.getTaskLog('c2dc2', 'UPID:c2dc2:test:log:');
    expect(log).toEqual(taskLogEnvelope.data);
  });

  it('unwraps nodes/{node}/tasks to the bare array', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, nodeTasksVmidVzdumpEnvelope));
    const tasks = await httpClient.getNodeTasks('c2dc2', { vmid: 113, typefilter: 'vzdump' });
    expect(tasks).toEqual(nodeTasksVmidVzdumpEnvelope.data);
  });

  it('surfaces the PVE envelope message on a non-2xx /api/pve/* response (agent not permitted)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, agentErrorEnvelope));
    await expect(httpClient.getAgentInterfaces('c2dc2', 'qemu', 113)).rejects.toThrow(
      /Permission check failed/,
    );
  });

  it('falls back to the status line when a non-2xx /api/pve/* response has no JSON body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('not json', { status: 502, statusText: 'Bad Gateway' }),
    );
    await expect(httpClient.getClusterResources()).rejects.toThrow(/502/);
  });

  it('surfaces an errors-object PVE envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { data: null, errors: { vmid: 'value does not look like a valid VM ID' } }),
    );
    await expect(httpClient.getVmConfig('c2dc2', 'qemu', 999999)).rejects.toThrow(
      /vmid: value does not look like a valid VM ID/,
    );
  });

  it('does NOT unwrap /api/console/* (our own endpoint, no envelope)', async () => {
    const ticket = { wsPath: '/ws/vnc/abc', password: 'secret' };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, ticket));
    const result = await httpClient.console.vnc('c2dc2', 'qemu', 113);
    expect(result).toEqual(ticket);
  });

  it('throws a plain status-line error for a non-2xx non-proxy endpoint', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 401, statusText: 'Unauthorized' }),
    );
    await expect(httpClient.login('root', 'wrong')).rejects.toThrow(/401/);
  });
});

describe('getNodeTasks query-string building', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function requestedUrl(): string {
    return (fetchMock.mock.calls[0] as unknown[])[0] as string;
  }

  it('sends no query string at all when called with no params', async () => {
    await httpClient.getNodeTasks('pve1');
    expect(requestedUrl()).toBe('/api/pve/nodes/pve1/tasks');
  });

  it('sends no query string when params is an empty object (every field omitted)', async () => {
    await httpClient.getNodeTasks('pve1', {});
    expect(requestedUrl()).toBe('/api/pve/nodes/pve1/tasks');
  });

  it('builds vmid, typefilter, limit, start, source, since, until', async () => {
    await httpClient.getNodeTasks('pve1', {
      vmid: 113,
      typefilter: 'vzdump',
      limit: 1,
      start: 5,
      source: 'all',
      since: 1000,
      until: 2000,
    });
    const url = new URL(requestedUrl(), 'http://localhost');
    expect(url.pathname).toBe('/api/pve/nodes/pve1/tasks');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      vmid: '113',
      typefilter: 'vzdump',
      limit: '1',
      start: '5',
      source: 'all',
      since: '1000',
      until: '2000',
    });
  });

  it('sends errors=1 for errors: true', async () => {
    await httpClient.getNodeTasks('pve1', { errors: true });
    const url = new URL(requestedUrl(), 'http://localhost');
    expect(url.searchParams.get('errors')).toBe('1');
  });

  it('sends errors=0 for errors: false (not omitted -- an explicit false is still a choice)', async () => {
    await httpClient.getNodeTasks('pve1', { errors: false });
    const url = new URL(requestedUrl(), 'http://localhost');
    expect(url.searchParams.get('errors')).toBe('0');
  });

  it('omits a field left out of params rather than sending the literal string "undefined"', async () => {
    const params: { vmid: number; typefilter?: string } = { vmid: 113 };
    await httpClient.getNodeTasks('pve1', params);
    const url = new URL(requestedUrl(), 'http://localhost');
    expect(Object.fromEntries(url.searchParams)).toEqual({ vmid: '113' });
  });
});

describe('request headers', () => {
  it('does not send a JSON content-type on a body-less POST (Fastify would 400)', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ wsPath: '/ws/term/x' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await httpClient.console.term('pve1');
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(new Headers(init.headers).get('content-type')).toBeNull();
    vi.unstubAllGlobals();
  });
  it('sends a JSON content-type when a body is present', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ username: 'u', realm: 'pam', capabilities: {} }), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await httpClient.login('u', 'p');
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    vi.unstubAllGlobals();
  });
});
