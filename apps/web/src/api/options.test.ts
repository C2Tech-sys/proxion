import { afterEach, describe, expect, it, vi } from 'vitest';

import { GuestActionError } from '@/api/actions';
import { updateGuestOptions, type OptionsPatch } from '@/api/options';

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

describe('updateGuestOptions (real mode)', () => {
  it('PATCHes /api/actions/guest/:node/:type/:vmid/options with exactly the given body', async () => {
    const result = { ok: true, changed: ['onboot', 'startup', 'tags', 'agent'], pending: ['agent'] };
    const fetchMock = stubFetch(200, result);
    const patch: OptionsPatch = {
      onboot: true,
      startup: { order: 1, up: 30 },
      tags: ['prod', 'db'],
      agent: { enabled: true, fstrimClonedDisks: true },
      localtime: null,
    };

    await expect(updateGuestOptions('pve1', 'qemu', 100, patch)).resolves.toStrictEqual(result);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/actions/guest/pve1/qemu/100/options', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toStrictEqual({
      onboot: true,
      startup: { order: 1, up: 30 },
      tags: ['prod', 'db'],
      agent: { enabled: true, fstrimClonedDisks: true },
      localtime: null,
    });
  });

  it('uses the lxc path for a container', async () => {
    const fetchMock = stubFetch(200, { ok: true, changed: ['nameserver'], pending: [] });
    await updateGuestOptions('pve2', 'lxc', 205, { nameserver: ['1.1.1.1'], searchdomain: null });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/actions/guest/pve2/lxc/205/options');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toStrictEqual({
      nameserver: ['1.1.1.1'],
      searchdomain: null,
    });
  });

  it('surfaces a 4xx as a GuestActionError carrying the status and the server message', async () => {
    stubFetch(400, { error: 'pve-rejected', message: 'startup: invalid format' });
    const error = await updateGuestOptions('pve1', 'qemu', 100, { startup: { order: 1 } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuestActionError);
    expect(error).toMatchObject({ status: 400, message: 'startup: invalid format' });
  });

  it('maps a forbidden body to the missing privilege, and an unparseable body to the status line', async () => {
    stubFetch(403, { error: 'forbidden', missing: 'VM.Config.Options' });
    await expect(updateGuestOptions('pve1', 'qemu', 100, { onboot: true })).rejects.toMatchObject({
      status: 403,
      message: "You don't have VM.Config.Options on this guest",
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 502, statusText: 'Bad Gateway' })));
    await expect(updateGuestOptions('pve1', 'qemu', 100, { onboot: true })).rejects.toMatchObject({
      status: 502,
      message: 'Request failed: 502 Bad Gateway',
    });
  });
});
