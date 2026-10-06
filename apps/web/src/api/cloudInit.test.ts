import { afterEach, describe, expect, it, vi } from 'vitest';

import { GuestActionError } from '@/api/actions';
import {
  getCloudInitPending,
  regenerateCloudInit,
  updateCloudInit,
  type CloudInitUpdate,
} from '@/api/cloudInit';

// Real mode (see `devices.test.ts` for why `USE_FIXTURES` is mocked off).
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return { ...actual, USE_FIXTURES: false };
});

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('getCloudInitPending (real mode)', () => {
  it('GETs /api/pve/nodes/:node/qemu/:vmid/cloudinit and returns the rows as sent', async () => {
    const rows = [
      { key: 'ciuser', value: 'admin' },
      { key: 'cipassword', value: '********', pending: '********' },
      { key: 'sshkeys', delete: 1 },
    ];
    const fetchMock = stubFetch(200, { data: rows });

    await expect(getCloudInitPending('pve1', 100)).resolves.toStrictEqual(rows);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/pve/nodes/pve1/qemu/100/cloudinit');
  });

  it('returns [] when data is not an array and throws on a non-OK response', async () => {
    stubFetch(200, { data: null });
    await expect(getCloudInitPending('pve1', 100)).resolves.toStrictEqual([]);
    stubFetch(500, {});
    await expect(getCloudInitPending('pve1', 100)).rejects.toThrow('Failed to load cloud-init values for qemu/100: 500');
  });
});

describe('updateCloudInit (real mode)', () => {
  it('PATCHes /api/actions/guest/:node/qemu/:vmid/cloud-init with exactly the given body', async () => {
    const result = { ok: true, pending: ['ciuser', 'ipconfig0'] };
    const fetchMock = stubFetch(200, result);
    const body: CloudInitUpdate = {
      user: 'admin',
      password: 's3cret-pw',
      sshKeys: ['ssh-ed25519 AAAA key1'],
      nameserver: ['1.1.1.1', '9.9.9.9'],
      searchdomain: null,
      upgrade: true,
      type: 'nocloud',
      ipconfig: { net0: { ip: 'dhcp' }, net1: null },
    };

    await expect(updateCloudInit('pve1', 100, body)).resolves.toStrictEqual(result);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/actions/guest/pve1/qemu/100/cloud-init', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  });

  it('keeps the password in the request body only, never in the URL', async () => {
    const fetchMock = stubFetch(200, { ok: true, pending: [] });
    await updateCloudInit('pve1', 100, { password: 'hunter2-hunter2' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/actions/guest/pve1/qemu/100/cloud-init');
    expect(init.body).toBe('{"password":"hunter2-hunter2"}');
  });

  it('surfaces a 4xx as a GuestActionError with the status and the server message', async () => {
    stubFetch(400, { error: 'pve-rejected', message: 'cipassword: value too short' });
    const error = await updateCloudInit('pve1', 100, { password: 'short' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuestActionError);
    expect(error).toMatchObject({ status: 400, message: 'cipassword: value too short' });

    stubFetch(409, { error: 'not-applicable' });
    await expect(updateCloudInit('pve1', 100, { user: 'x' })).rejects.toMatchObject({
      status: 409,
      message: 'Cloud-Init is only available on VMs',
    });
  });
});

describe('regenerateCloudInit (real mode)', () => {
  it('POSTs /api/actions/guest/:node/qemu/:vmid/cloud-init/regenerate with no body', async () => {
    const fetchMock = stubFetch(200, { ok: true });

    await expect(regenerateCloudInit('pve1', 100)).resolves.toStrictEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/actions/guest/pve1/qemu/100/cloud-init/regenerate', {
      method: 'POST',
    });
  });

  it('surfaces a 4xx as a GuestActionError', async () => {
    stubFetch(403, { error: 'forbidden', missing: 'VM.Config.Cloudinit' });
    await expect(regenerateCloudInit('pve1', 100)).rejects.toMatchObject({
      name: 'GuestActionError',
      status: 403,
      message: "You don't have VM.Config.Cloudinit on this guest",
    });
  });
});
