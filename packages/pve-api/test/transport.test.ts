import { describe, expect, it, vi } from 'vitest';
import { Headers, Response, type RequestInfo, type RequestInit } from 'undici';
import { PveHttp, PveApiError } from '../src/index.js';

type FetchMock = ReturnType<typeof createFetchMock>;

function jsonResponse(status: number, body: unknown, statusText = 'OK'): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A `PveHttp`-compatible fetch mock (undici's `fetch` shape, not the global
 * one -- see `src/http.ts` for why the two don't mix) whose `.mock.calls` are
 * typed as `[url, init]` tuples. Clones the response per call since a
 * `Response` body can only be read once, and some tests invoke the same
 * mocked request twice.
 */
function createFetchMock(response: Response) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- shape (not use) of these params drives the mock's call-tuple typing
  return vi.fn(async (_url: RequestInfo, _init?: RequestInit) => response.clone());
}

function makeHttp(fetchMock: FetchMock): PveHttp {
  return new PveHttp({
    baseUrl: 'https://pve.example.com:8006',
    credentials: { type: 'token', tokenId: 'root@pam!proxion', tokenSecret: 'super-secret' },
    fetch: fetchMock,
  });
}

function makeTicketHttp(fetchMock: FetchMock, ticket: string): PveHttp {
  return new PveHttp({
    baseUrl: 'https://pve.example.com:8006',
    credentials: { type: 'ticket', ticket, csrfToken: 'csrf-token' },
    fetch: fetchMock,
  });
}

describe('PveHttp request building', () => {
  it('substitutes path params and sends the rest as a GET query string', async () => {
    const fetchMock = createFetchMock(jsonResponse(200, { data: { ok: true } }));
    const http = makeHttp(fetchMock);

    await http.request('GET', '/nodes/{node}/qemu/{vmid}/status/current', {
      node: 'pve',
      vmid: 100,
      full: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://pve.example.com:8006/api2/json/nodes/pve/qemu/100/status/current?full=1',
    );
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
  });

  it('sends remaining params as a DELETE query string', async () => {
    const fetchMock = createFetchMock(jsonResponse(200, { data: null }));
    const http = makeHttp(fetchMock);

    await http.request('DELETE', '/nodes/{node}/qemu/{vmid}', {
      node: 'pve',
      vmid: 100,
      purge: true,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://pve.example.com:8006/api2/json/nodes/pve/qemu/100?purge=1');
    expect(init?.method).toBe('DELETE');
  });

  it('sends remaining params as an urlencoded body for POST', async () => {
    const fetchMock = createFetchMock(jsonResponse(200, { data: { upid: 'UPID:...' } }));
    const http = makeHttp(fetchMock);

    await http.request('POST', '/nodes/{node}/qemu', {
      node: 'pve',
      vmid: 999,
      onboot: true,
      protection: false,
      tags: ['a', 'b', 'c'],
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://pve.example.com:8006/api2/json/nodes/pve/qemu');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(init?.body as string);
    expect(body.get('vmid')).toBe('999');
    expect(body.get('onboot')).toBe('1');
    expect(body.get('protection')).toBe('0');
    expect(body.get('tags')).toBe('a,b,c');
    // path params are consumed, not resent
    expect(body.has('node')).toBe(false);
  });

  it('sends remaining params as an urlencoded body for PUT', async () => {
    const fetchMock = createFetchMock(jsonResponse(200, { data: null }));
    const http = makeHttp(fetchMock);

    await http.request('PUT', '/nodes/{node}/qemu/{vmid}/config', {
      node: 'pve',
      vmid: 100,
      cores: 4,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe('PUT');
    const headers = new Headers(init?.headers);
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(init?.body as string);
    expect(body.get('cores')).toBe('4');
  });

  it('sends the PVEAPIToken authorization header', async () => {
    const fetchMock = createFetchMock(jsonResponse(200, { data: {} }));
    const http = makeHttp(fetchMock);

    await http.request('GET', '/version', {});

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('PVEAPIToken=root@pam!proxion=super-secret');
  });

  it('sends the ticket cookie and CSRF header in ticket mode, with the ticket URL-encoded', async () => {
    const fetchMock = createFetchMock(jsonResponse(200, { data: {} }));
    // A `:`-containing ticket, as PVE actually issues (`PVE:user@realm:hexstamp::signature`),
    // so an unencoded cookie would be a real corruption risk, not just theoretical.
    const ticket = 'PVE:root@pam:6512ABCD::signature-with/special+chars=';
    const http = makeTicketHttp(fetchMock, ticket);

    await http.request('GET', '/version', {});

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get('cookie')).toBe(`PVEAuthCookie=${encodeURIComponent(ticket)}`);
    expect(headers.get('cookie')).not.toContain('@');
    expect(headers.get('csrfpreventiontoken')).toBe('csrf-token');
  });

  it('unwraps the `data` envelope on success', async () => {
    const fetchMock = createFetchMock(jsonResponse(200, { data: { version: '9.0' } }));
    const http = makeHttp(fetchMock);

    const result = await http.request('GET', '/version', {});
    expect(result).toEqual({ version: '9.0' });
  });

  it('raises PveApiError on a non-2xx response, carrying status and errors', async () => {
    const fetchMock = createFetchMock(
      jsonResponse(
        500,
        { data: null, errors: { vmid: 'already in use' } },
        'Internal Server Error',
      ),
    );
    const http = makeHttp(fetchMock);

    await expect(
      http.request('POST', '/nodes/{node}/qemu', { node: 'pve', vmid: 100 }),
    ).rejects.toMatchObject({
      status: 500,
      errors: { vmid: 'already in use' },
    });
    await expect(
      http.request('POST', '/nodes/{node}/qemu', { node: 'pve', vmid: 100 }),
    ).rejects.toBeInstanceOf(PveApiError);
  });

  it('throws when a required path param is missing', async () => {
    const fetchMock = createFetchMock(jsonResponse(200, { data: {} }));
    const http = makeHttp(fetchMock);

    await expect(
      http.request('GET', '/nodes/{node}/qemu/{vmid}/status/current', { node: 'pve' }),
    ).rejects.toThrow(/Missing required path parameter "vmid"/);
  });

  it('substitutes a hyphenated path param (e.g. {route-map-id}), not just \\w+ segments', async () => {
    const fetchMock = createFetchMock(jsonResponse(200, { data: [] }));
    const http = makeHttp(fetchMock);

    await http.request('GET', '/cluster/sdn/route-maps/entries/{route-map-id}', {
      'route-map-id': 'my-route-map',
      pending: true,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    // The literal `{route-map-id}` must be gone from the URL, replaced by the
    // value -- not left in place with the value leaked into the query string.
    expect(String(url)).toBe(
      'https://pve.example.com:8006/api2/json/cluster/sdn/route-maps/entries/my-route-map?pending=1',
    );
    expect(init?.method).toBe('GET');
  });

  it('substitutes a second hyphenated path param shape ({pci-id-or-mapping})', async () => {
    const fetchMock = createFetchMock(jsonResponse(200, { data: [] }));
    const http = makeHttp(fetchMock);

    await http.request('GET', '/nodes/{node}/hardware/pci/{pci-id-or-mapping}', {
      node: 'pve',
      'pci-id-or-mapping': '0000:01:00.0',
    });

    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://pve.example.com:8006/api2/json/nodes/pve/hardware/pci/0000%3A01%3A00.0',
    );
  });
});

describe('PveHttp ticket + CSRF credentials', () => {
  function makeTicketHttp(fetchMock: FetchMock): PveHttp {
    return new PveHttp({
      baseUrl: 'https://pve.example.com:8006',
      credentials: {
        type: 'ticket',
        ticket: 'PVE:root@pam:ABCDEF::signature',
        csrfToken: 'csrf-token-value',
      },
      fetch: fetchMock,
    });
  }

  it('sends the PVEAuthCookie and CSRFPreventionToken headers on a state-changing POST', async () => {
    const fetchMock = createFetchMock(jsonResponse(200, { data: { upid: 'UPID:...' } }));
    const http = makeTicketHttp(fetchMock);

    await http.request('POST', '/nodes/{node}/qemu/{vmid}/status/start', {
      node: 'pve',
      vmid: 100,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get('cookie')).toBe('PVEAuthCookie=PVE%3Aroot%40pam%3AABCDEF%3A%3Asignature');
    expect(headers.get('csrfpreventiontoken')).toBe('csrf-token-value');
  });

  it('also sends the PVEAuthCookie (but CSRF header is still present) on a GET', async () => {
    const fetchMock = createFetchMock(jsonResponse(200, { data: { version: '9.0' } }));
    const http = makeTicketHttp(fetchMock);

    await http.request('GET', '/version', {});

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get('cookie')).toBe('PVEAuthCookie=PVE%3Aroot%40pam%3AABCDEF%3A%3Asignature');
    expect(headers.get('csrfpreventiontoken')).toBe('csrf-token-value');
  });
});

describe('PveHttp dispatcher option', () => {
  it('throws when both `tls` and `dispatcher` are given', () => {
    expect(
      () =>
        new PveHttp({
          baseUrl: 'https://pve.example.com:8006',
          credentials: { type: 'token', tokenId: 'root@pam!x', tokenSecret: 's' },
          tls: { insecure: true },
          dispatcher: {} as never,
        }),
    ).toThrow(/either `dispatcher` or `tls`, not both/);
  });

  it('close() is a no-op when the dispatcher was injected, not built from `tls`', async () => {
    const injectedClose = vi.fn(async () => {});
    const http = new PveHttp({
      baseUrl: 'https://pve.example.com:8006',
      credentials: { type: 'token', tokenId: 'root@pam!x', tokenSecret: 's' },
      dispatcher: { close: injectedClose } as never,
    });

    await http.close();

    expect(injectedClose).not.toHaveBeenCalled();
  });

  it('close() is a no-op when no `tls`/`dispatcher` was given at all', async () => {
    const http = new PveHttp({
      baseUrl: 'https://pve.example.com:8006',
      credentials: { type: 'token', tokenId: 'root@pam!x', tokenSecret: 's' },
    });

    await expect(http.close()).resolves.toBeUndefined();
  });
});
