import { describe, expect, it, vi } from 'vitest';
import type { Dispatcher } from 'undici';
import { PveHttp, PveApiError } from '../src/index.js';

/**
 * A fake undici `Dispatcher` recording every `request()` call it received, for exercising
 * `PveHttp.stream()` (T32) without a real socket -- same "inject a fake transport seam" idea
 * `transport.test.ts` uses for `fetch` itself, just one level lower (`stream()` bypasses `fetch()`
 * entirely -- see its own doc comment in `src/http.ts`).
 */
function createFakeDispatcher(statusCode: number, body: string) {
  const calls: Dispatcher.RequestOptions[] = [];
  const request = vi.fn(async (options: Dispatcher.RequestOptions): Promise<Dispatcher.ResponseData> => {
    calls.push(options);
    async function* bodyIterable() {
      yield Buffer.from(body);
    }
    return {
      statusCode,
      headers: {},
      trailers: {},
      opaque: null,
      context: {},
      body: bodyIterable(),
    } as unknown as Dispatcher.ResponseData;
  });
  const dispatcher = { request, close: vi.fn(async () => {}) } as unknown as Dispatcher;
  return { dispatcher, calls };
}

function makeHttp(dispatcher: Dispatcher, credentials: ConstructorParameters<typeof PveHttp>[0]['credentials']) {
  return new PveHttp({ baseUrl: 'https://pve.example.com:8006', credentials, dispatcher });
}

describe('PveHttp.stream', () => {
  it('resolves the PVE envelope data on a 2xx response', async () => {
    const { dispatcher } = createFakeDispatcher(200, JSON.stringify({ data: 'UPID:pve:00000001::::imgcopy::root@pam:' }));
    const http = makeHttp(dispatcher, { type: 'token', tokenId: 'root@pam!x', tokenSecret: 's' });

    const result = await http.stream(
      'POST',
      '/nodes/{node}/storage/{storage}/upload',
      { node: 'pve', storage: 'local' },
      { headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: Buffer.from('abc'), contentLength: 3 },
    );

    expect(result).toBe('UPID:pve:00000001::::imgcopy::root@pam:');
  });

  it('substitutes path params, forwards content-type/content-length, and never sets a redirect option', async () => {
    const { dispatcher, calls } = createFakeDispatcher(200, JSON.stringify({ data: null }));
    const http = makeHttp(dispatcher, { type: 'token', tokenId: 'root@pam!x', tokenSecret: 's' });

    await http.stream(
      'POST',
      '/nodes/{node}/storage/{storage}/upload',
      { node: 'pve1', storage: 'local' },
      { headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: Buffer.from('abcde'), contentLength: 5 },
    );

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.origin).toBe('https://pve.example.com:8006');
    expect(call.path).toBe('/api2/json/nodes/pve1/storage/local/upload');
    expect(call.method).toBe('POST');
    const headers = call.headers as Record<string, string>;
    expect(headers['content-type']).toBe('multipart/form-data; boundary=x');
    expect(headers['content-length']).toBe('5');
    // undici's low-level `Dispatcher.request()` never follows redirects on its own (unlike
    // `fetch()`'s default `redirect: 'follow'`) -- there is no `redirect` option to even set here,
    // which is itself the guarantee: this path structurally cannot be told to follow one.
    expect(call).not.toHaveProperty('redirect');
  });

  it('sends the PVEAPIToken authorization header in token mode', async () => {
    const { dispatcher, calls } = createFakeDispatcher(200, JSON.stringify({ data: null }));
    const http = makeHttp(dispatcher, { type: 'token', tokenId: 'root@pam!proxion', tokenSecret: 'super-secret' });

    await http.stream('POST', '/nodes/{node}/storage/{storage}/upload', { node: 'pve', storage: 'local' }, {
      body: Buffer.from('x'),
      contentLength: 1,
    });

    const headers = calls[0]!.headers as Record<string, string>;
    expect(headers.authorization).toBe('PVEAPIToken=root@pam!proxion=super-secret');
  });

  it('sends the ticket cookie and CSRF header in ticket mode', async () => {
    const { dispatcher, calls } = createFakeDispatcher(200, JSON.stringify({ data: null }));
    const http = makeHttp(dispatcher, {
      type: 'ticket',
      ticket: 'PVE:root@pam:ABCDEF::signature',
      csrfToken: 'csrf-token-value',
    });

    await http.stream('POST', '/nodes/{node}/storage/{storage}/upload', { node: 'pve', storage: 'local' }, {
      body: Buffer.from('x'),
      contentLength: 1,
    });

    const headers = calls[0]!.headers as Record<string, string>;
    expect(headers.cookie).toBe('PVEAuthCookie=PVE%3Aroot%40pam%3AABCDEF%3A%3Asignature');
    expect(headers.csrfpreventiontoken).toBe('csrf-token-value');
  });

  it('sets a headers/body timeout of at least one hour', async () => {
    const { dispatcher, calls } = createFakeDispatcher(200, JSON.stringify({ data: null }));
    const http = makeHttp(dispatcher, { type: 'token', tokenId: 'root@pam!x', tokenSecret: 's' });

    await http.stream('POST', '/nodes/{node}/storage/{storage}/upload', { node: 'pve', storage: 'local' }, {
      body: Buffer.from('x'),
      contentLength: 1,
    });

    const ONE_HOUR_MS = 60 * 60 * 1000;
    expect(calls[0]!.headersTimeout).toBeGreaterThanOrEqual(ONE_HOUR_MS);
    expect(calls[0]!.bodyTimeout).toBeGreaterThanOrEqual(ONE_HOUR_MS);
  });

  it('propagates an AbortSignal straight to the dispatcher request', async () => {
    const { dispatcher, calls } = createFakeDispatcher(200, JSON.stringify({ data: null }));
    const http = makeHttp(dispatcher, { type: 'token', tokenId: 'root@pam!x', tokenSecret: 's' });
    const controller = new AbortController();

    await http.stream('POST', '/nodes/{node}/storage/{storage}/upload', { node: 'pve', storage: 'local' }, {
      body: Buffer.from('x'),
      contentLength: 1,
      signal: controller.signal,
    });

    expect(calls[0]!.signal).toBe(controller.signal);
  });

  it('raises PveApiError on a non-2xx response, carrying status and message', async () => {
    const { dispatcher } = createFakeDispatcher(400, JSON.stringify({ data: null, message: 'unsupported file extension' }));
    const http = makeHttp(dispatcher, { type: 'token', tokenId: 'root@pam!x', tokenSecret: 's' });

    await expect(
      http.stream('POST', '/nodes/{node}/storage/{storage}/upload', { node: 'pve', storage: 'local' }, {
        body: Buffer.from('x'),
        contentLength: 1,
      }),
    ).rejects.toMatchObject({ status: 400, message: 'unsupported file extension' });
    await expect(
      http.stream('POST', '/nodes/{node}/storage/{storage}/upload', { node: 'pve', storage: 'local' }, {
        body: Buffer.from('x'),
        contentLength: 1,
      }),
    ).rejects.toBeInstanceOf(PveApiError);
  });
});
