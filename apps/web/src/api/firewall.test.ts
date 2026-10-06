import { afterEach, describe, expect, it, vi } from 'vitest';

import { GuestActionError } from '@/api/actions';
import {
  addFirewallRule,
  deleteFirewallRule,
  getFirewallOptions,
  getFirewallRules,
  getMacros,
  getSecurityGroups,
  updateFirewallOptions,
  updateFirewallRule,
} from '@/api/firewall';

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

const JSON_HEADERS = { 'content-type': 'application/json' };

afterEach(() => vi.unstubAllGlobals());

describe('getFirewallRules (real mode)', () => {
  it('GETs the rules path for the guest and returns the rows as PVE sent them (enable stays 0/1)', async () => {
    const rows = [
      { pos: 0, type: 'in', action: 'ACCEPT', enable: 1, proto: 'tcp', dport: '22', comment: 'ssh', digest: 'd1' },
      { pos: 1, type: 'group', action: 'web', enable: 0 },
    ];
    const fetchMock = stubFetch(200, { data: rows });

    await expect(getFirewallRules('pve1', 'qemu', 100)).resolves.toStrictEqual(rows);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/pve/nodes/pve1/qemu/100/firewall/rules');
  });

  it('uses the lxc type in the path, returns [] for a non-array and throws a GuestActionError on a non-OK', async () => {
    const fetchMock = stubFetch(200, { data: null });
    await expect(getFirewallRules('pve2', 'lxc', 205)).resolves.toStrictEqual([]);
    expect(fetchMock).toHaveBeenCalledWith('/api/pve/nodes/pve2/lxc/205/firewall/rules');

    stubFetch(500, {});
    const error = await getFirewallRules('pve1', 'qemu', 100).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuestActionError);
    expect(error).toMatchObject({ status: 500 });
  });
});

describe('getFirewallOptions (real mode)', () => {
  it('GETs the options path and normalises 0/1 (and true / "1") to booleans', async () => {
    const fetchMock = stubFetch(200, {
      data: {
        enable: 1,
        dhcp: 0,
        ndp: 0,
        radv: '1',
        macfilter: false,
        ipfilter: true,
        policy_in: 'DROP',
        policy_out: 'ACCEPT',
        log_level_in: 'info',
        log_level_out: 'nolog',
        digest: 'abc123',
      },
    });

    await expect(getFirewallOptions('pve1', 'qemu', 100)).resolves.toStrictEqual({
      enable: true,
      dhcp: false,
      ndp: false,
      radv: true,
      macfilter: false,
      ipfilter: true,
      policy_in: 'DROP',
      policy_out: 'ACCEPT',
      log_level_in: 'info',
      log_level_out: 'nolog',
      digest: 'abc123',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/pve/nodes/pve1/qemu/100/firewall/options');
  });

  it('fills PVE defaults for absent keys (ndp and macfilter on, the rest off) and drops unknown enum values', async () => {
    stubFetch(200, { data: { policy_in: 'MAYBE', log_level_in: 'loud', digest: 7 } });

    await expect(getFirewallOptions('pve1', 'lxc', 205)).resolves.toStrictEqual({
      enable: false,
      dhcp: false,
      ndp: true,
      radv: false,
      macfilter: true,
      ipfilter: false,
      policy_in: undefined,
      policy_out: undefined,
      log_level_in: undefined,
      log_level_out: undefined,
      digest: undefined,
    });
  });

  it('throws on a non-OK response', async () => {
    stubFetch(500, {});
    await expect(getFirewallOptions('pve1', 'qemu', 100)).rejects.toMatchObject({ status: 500 });
  });
});

describe('getSecurityGroups / getMacros (real mode)', () => {
  it('getSecurityGroups reads the cluster groups, keeps non-empty comments and sorts by name', async () => {
    const fetchMock = stubFetch(200, {
      data: [{ group: 'web', comment: 'HTTP(S)' }, { group: 'admin', comment: '' }, { comment: 'no name' }],
    });
    await expect(getSecurityGroups()).resolves.toStrictEqual([{ group: 'admin' }, { group: 'web', comment: 'HTTP(S)' }]);
    expect(fetchMock).toHaveBeenCalledWith('/api/pve/cluster/firewall/groups');
  });

  it('getMacros reads the macro list, keeps non-empty descriptions and sorts by name', async () => {
    const fetchMock = stubFetch(200, {
      data: [{ macro: 'SSH', descr: 'Secure shell' }, { macro: 'DNS', descr: '' }, { descr: 'no name' }],
    });
    await expect(getMacros()).resolves.toStrictEqual([{ macro: 'DNS' }, { macro: 'SSH', descr: 'Secure shell' }]);
    expect(fetchMock).toHaveBeenCalledWith('/api/pve/cluster/firewall/macros');
  });

  it('both return [] on a 403 (no datacenter firewall access)', async () => {
    stubFetch(403, {});
    await expect(getSecurityGroups()).resolves.toStrictEqual([]);
    await expect(getMacros()).resolves.toStrictEqual([]);
  });

  it('both throw a GuestActionError on a 500', async () => {
    stubFetch(500, {});
    await expect(getSecurityGroups()).rejects.toMatchObject({ name: 'GuestActionError', status: 500 });
    await expect(getMacros()).rejects.toMatchObject({ name: 'GuestActionError', status: 500 });
  });

  it('both return [] when data is not an array', async () => {
    stubFetch(200, { data: null });
    await expect(getSecurityGroups()).resolves.toStrictEqual([]);
    await expect(getMacros()).resolves.toStrictEqual([]);
  });
});

describe('addFirewallRule (real mode)', () => {
  it('POSTs the exact body to .../firewall/rules', async () => {
    const fetchMock = stubFetch(201, { ok: true });
    const body = {
      type: 'in' as const,
      action: 'ACCEPT',
      enable: false,
      proto: 'tcp',
      dport: '22',
      comment: 'ssh',
      icmpType: 'echo-request',
      pos: 0,
    };

    await expect(addFirewallRule('pve1', 'qemu', 100, body)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/actions/guest/pve1/qemu/100/firewall/rules', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: '{"type":"in","action":"ACCEPT","enable":false,"proto":"tcp","dport":"22","comment":"ssh","icmpType":"echo-request","pos":0}',
    });
  });

  it('accepts a 200 as well and uses the lxc path', async () => {
    const fetchMock = stubFetch(200, { ok: true });
    await addFirewallRule('pve2', 'lxc', 205, { type: 'group', action: 'web' });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/actions/guest/pve2/lxc/205/firewall/rules');
    expect(fetchMock.mock.calls[0]![1].body).toBe('{"type":"group","action":"web"}');
  });

  it('surfaces a 4xx as a GuestActionError with the server message', async () => {
    stubFetch(400, { error: 'pve-rejected', message: 'dport: invalid port range' });
    const error = await addFirewallRule('pve1', 'qemu', 100, { type: 'in', action: 'DROP' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuestActionError);
    expect(error).toMatchObject({ status: 400, message: 'dport: invalid port range' });
  });
});

describe('updateFirewallRule (real mode)', () => {
  it('PUTs the exact patch (incl. delete list and digest) to .../firewall/rules/:pos', async () => {
    const fetchMock = stubFetch(200, { ok: true });

    await expect(
      updateFirewallRule('pve1', 'qemu', 100, 2, {
        action: 'DROP',
        enable: true,
        moveto: 0,
        delete: ['comment', 'icmpType'],
        digest: 'abc123',
      }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/actions/guest/pve1/qemu/100/firewall/rules/2', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: '{"action":"DROP","enable":true,"moveto":0,"delete":["comment","icmpType"],"digest":"abc123"}',
    });
  });

  it('surfaces a 4xx (stale digest) as a GuestActionError with the status and message', async () => {
    stubFetch(400, { error: 'pve-rejected', message: 'detected modified configuration - file changed by other user' });
    const error = await updateFirewallRule('pve1', 'qemu', 100, 2, { enable: false, digest: 'old' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GuestActionError);
    expect(error).toMatchObject({
      status: 400,
      message: 'detected modified configuration - file changed by other user',
    });
  });

  it('maps a forbidden body to the missing privilege', async () => {
    stubFetch(403, { error: 'forbidden', missing: 'VM.Config.Network' });
    await expect(updateFirewallRule('pve1', 'qemu', 100, 0, { enable: true })).rejects.toMatchObject({
      status: 403,
      message: "You don't have VM.Config.Network on this guest",
    });
  });
});

describe('deleteFirewallRule (real mode)', () => {
  it('DELETEs .../firewall/rules/:pos with the digest URL-encoded in the query', async () => {
    const fetchMock = stubFetch(200, { ok: true });

    await expect(deleteFirewallRule('pve1', 'qemu', 100, 3, 'a b+c/d')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/actions/guest/pve1/qemu/100/firewall/rules/3?digest=a%20b%2Bc%2Fd', {
      method: 'DELETE',
    });
  });

  it('sends no query string when no digest is given', async () => {
    const fetchMock = stubFetch(200, { ok: true });
    await deleteFirewallRule('pve2', 'lxc', 205, 0);
    expect(fetchMock).toHaveBeenCalledWith('/api/actions/guest/pve2/lxc/205/firewall/rules/0', { method: 'DELETE' });
  });

  it('surfaces a 4xx as a GuestActionError', async () => {
    stubFetch(404, { error: 'pve-rejected', message: 'no such rule' });
    await expect(deleteFirewallRule('pve1', 'qemu', 100, 9)).rejects.toMatchObject({
      name: 'GuestActionError',
      status: 404,
      message: 'no such rule',
    });
  });
});

describe('updateFirewallOptions (real mode)', () => {
  it('PUTs the exact patch (booleans as booleans, digest included) to .../firewall/options', async () => {
    const fetchMock = stubFetch(200, { ok: true });

    await expect(
      updateFirewallOptions('pve1', 'qemu', 100, {
        enable: true,
        ndp: false,
        policy_in: 'DROP',
        log_level_in: 'info',
        digest: 'abc123',
      }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/actions/guest/pve1/qemu/100/firewall/options', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: '{"enable":true,"ndp":false,"policy_in":"DROP","log_level_in":"info","digest":"abc123"}',
    });
  });

  it('surfaces a 4xx and a token-mode refusal as GuestActionErrors with readable messages', async () => {
    stubFetch(400, { error: 'pve-rejected', message: 'policy_in: value is not allowed' });
    await expect(updateFirewallOptions('pve1', 'qemu', 100, { enable: true })).rejects.toMatchObject({
      status: 400,
      message: 'policy_in: value is not allowed',
    });

    stubFetch(403, { error: 'writes-disabled-in-token-mode' });
    await expect(updateFirewallOptions('pve1', 'qemu', 100, { enable: true })).rejects.toMatchObject({
      status: 403,
      message: 'Read-only: signed in with a service token',
    });
  });
});
