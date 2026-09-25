import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSnapshot, deleteSnapshot, guestAction, rollbackSnapshot, GuestActionError } from '@/api/actions';

// Forces the real (non-fixture) code path in `guestAction` so its `fetch()`-based request and
// error mapping actually run, rather than the fixture flip -- see `auth-gate.render.test.tsx`
// for the same pattern used elsewhere in this app. `vi.mock` calls are hoisted above these
// imports by vitest's transform, so `guestAction` sees the mocked `USE_FIXTURES` regardless of
// source order.
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return { ...actual, USE_FIXTURES: false };
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('guestAction (real client)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves with the upid on 202', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { upid: 'UPID:pve1:...' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await guestAction('pve1', 'qemu', 100, 'start');
    expect(result).toEqual({ upid: 'UPID:pve1:...' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/actions/guest/pve1/qemu/100/start');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('sends the body JSON-encoded', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { upid: 'UPID:x' }));
    vi.stubGlobal('fetch', fetchMock);

    await guestAction('pve1', 'qemu', 100, 'shutdown', { forceStop: true, timeout: 120 });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ forceStop: true, timeout: 120 });
  });

  it('maps writes-disabled-in-token-mode to a readable message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(403, { error: 'writes-disabled-in-token-mode' })),
    );

    const error = await guestAction('pve1', 'qemu', 100, 'start').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuestActionError);
    expect((error as InstanceType<typeof GuestActionError>).status).toBe(403);
    expect((error as Error).message).toBe('Read-only: signed in with a service token');
  });

  it('maps forbidden (missing VM.PowerMgmt) to a readable message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(403, { error: 'forbidden', missing: 'VM.PowerMgmt' })),
    );

    const error = await guestAction('pve1', 'qemu', 100, 'start').catch((e: unknown) => e);
    expect((error as Error).message).toBe("You don't have VM.PowerMgmt on this guest");
  });

  it('surfaces a PVE 4xx message verbatim', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(400, { error: 'pve-rejected', message: 'VM 100 is already running' }),
      ),
    );

    const error = await guestAction('pve1', 'qemu', 100, 'start').catch((e: unknown) => e);
    expect((error as InstanceType<typeof GuestActionError>).status).toBe(400);
    expect((error as Error).message).toBe('VM 100 is already running');
  });

  it('maps pve-unreachable to a readable message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(502, { error: 'pve-unreachable' })));

    const error = await guestAction('pve1', 'qemu', 100, 'start').catch((e: unknown) => e);
    expect((error as Error).message).toBe('Proxmox VE is unreachable');
  });
});

describe('createSnapshot/deleteSnapshot/rollbackSnapshot (real client)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('createSnapshot POSTs the body JSON-encoded and resolves with the upid on 202', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { upid: 'UPID:pve1:snap' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createSnapshot('pve1', 'qemu', 100, {
      snapname: 'pre-upgrade',
      description: 'before the upgrade',
      vmstate: true,
    });
    expect(result).toEqual({ upid: 'UPID:pve1:snap' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/actions/guest/pve1/qemu/100/snapshots');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      snapname: 'pre-upgrade',
      description: 'before the upgrade',
      vmstate: true,
    });
  });

  it('createSnapshot surfaces the server\'s invalid-snapname message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(400, { error: 'invalid-snapname', message: 'Name must start with a letter.' })),
    );

    const error = await createSnapshot('pve1', 'qemu', 100, { snapname: '1bad' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuestActionError);
    expect((error as Error).message).toBe('Name must start with a letter.');
  });

  it('deleteSnapshot DELETEs with ?force=1 when requested', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { upid: 'UPID:pve1:del' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await deleteSnapshot('pve1', 'qemu', 100, 'pre-upgrade', { force: true });
    expect(result).toEqual({ upid: 'UPID:pve1:del' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/actions/guest/pve1/qemu/100/snapshots/pre-upgrade?force=1');
    expect(init.method).toBe('DELETE');
  });

  it('deleteSnapshot omits the query string when force is not requested', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { upid: 'UPID:pve1:del' }));
    vi.stubGlobal('fetch', fetchMock);

    await deleteSnapshot('pve1', 'qemu', 100, 'pre-upgrade');

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/actions/guest/pve1/qemu/100/snapshots/pre-upgrade');
  });

  it('rollbackSnapshot POSTs { start } and resolves with the upid on 202', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { upid: 'UPID:pve1:rb' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await rollbackSnapshot('pve1', 'qemu', 100, 'pre-upgrade', { start: true });
    expect(result).toEqual({ upid: 'UPID:pve1:rb' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/actions/guest/pve1/qemu/100/snapshots/pre-upgrade/rollback');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ start: true });
  });

  it('rollbackSnapshot maps pve-unreachable to a readable message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(502, { error: 'pve-unreachable' })));

    const error = await rollbackSnapshot('pve1', 'qemu', 100, 'pre-upgrade').catch((e: unknown) => e);
    expect((error as Error).message).toBe('Proxmox VE is unreachable');
  });
});
