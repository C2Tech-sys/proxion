import * as http from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

/**
 * Storage upload / download-from-URL / query-url-metadata / delete (T32 + addendum), mirroring
 * `nodeActions.test.ts`'s own setup conventions (`app.inject`, `startFakePve`, a session cookie
 * from a real login round-trip against the fake PVE).
 */
describe('storage action routes', () => {
  let fakePve: FakePve;
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    await fakePve?.close();
  });

  async function setupSession(configOverrides: Record<string, string> = {}): Promise<string> {
    fakePve = await startFakePve();
    app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url, ...configOverrides }) });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root', password: 'goodpass', realm: 'pam' },
    });
    const setCookie = login.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!raw) throw new Error('login did not set a session cookie');
    return raw.split(';')[0]!;
  }

  async function setupTokenMode(): Promise<void> {
    fakePve = await startFakePve();
    app = await buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        PVE_URL: fakePve.url,
        PVE_TOKEN_ID: 'root@pam!proxion',
        PVE_TOKEN_SECRET: 'tokensecret',
        PROXION_ALLOW_TOKEN_MODE: 'true',
      }),
    });
  }

  const BOUNDARY = '----storageActionsTestBoundary';

  /** Builds a real multipart/form-data body: `content`, then the file itself as a part named
   * `filename` (T35) -- same field order/naming the web client builds (`api/actions.ts`'s
   * `uploadToStorage`), which is itself dictated by what real pveproxy's own multipart parser
   * (`PVE::APIServer::AnyEvent::file_upload_multipart`) requires: the file part's own field name
   * must be `filename`, with the target filename carried in that part's `filename="..."`
   * attribute -- there is no separate text field for it. */
  function buildMultipartBody(fields: { content: string; filename: string }, fileBytes: Buffer): Buffer {
    const CRLF = '\r\n';
    return Buffer.concat([
      Buffer.from(`--${BOUNDARY}${CRLF}Content-Disposition: form-data; name="content"${CRLF}${CRLF}${fields.content}${CRLF}`),
      Buffer.from(
        `--${BOUNDARY}${CRLF}Content-Disposition: form-data; name="filename"; filename="${fields.filename}"${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`,
      ),
      fileBytes,
      Buffer.from(`${CRLF}--${BOUNDARY}--${CRLF}`),
    ]);
  }

  /** The T35 bug, reproduced byte-for-byte: `content`, a separate text `filename` field, then the
   * file data as a part named `file` -- what this server (and the real web client, before T35)
   * used to send. Real pveproxy refuses this immediately (see `fakePve.ts`'s own strict check,
   * mirroring `file_upload_multipart`'s `die`), never reaching the rest of the body at all. */
  function buildLegacyMultipartBody(fields: { content: string; filename: string }, fileBytes: Buffer): Buffer {
    const CRLF = '\r\n';
    return Buffer.concat([
      Buffer.from(`--${BOUNDARY}${CRLF}Content-Disposition: form-data; name="content"${CRLF}${CRLF}${fields.content}${CRLF}`),
      Buffer.from(`--${BOUNDARY}${CRLF}Content-Disposition: form-data; name="filename"${CRLF}${CRLF}${fields.filename}${CRLF}`),
      Buffer.from(
        `--${BOUNDARY}${CRLF}Content-Disposition: form-data; name="file"; filename="${fields.filename}"${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`,
      ),
      fileBytes,
      Buffer.from(`${CRLF}--${BOUNDARY}--${CRLF}`),
    ]);
  }

  /**
   * Sends a real (not `app.inject()`) multipart upload request over a real socket and resolves
   * with the response actually read back -- unlike `app.inject()`, whose in-process request wraps
   * the payload one level below where `req.raw`'s own `aborted`/`close` events fire (see the
   * existing "client abort" test's own comment below), a real socket is what actually exercises
   * the T35 fix: `req.raw` piped into its own `PassThrough` so Proxmox's own early reply is never
   * at risk of being discarded when undici tears down the *upstream* body once that reply lands.
   */
  function realSocketUploadRequest(address: string, cookie: string, body: Buffer): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${address}/api/actions/storage/pve1/local/upload?content=iso&filename=big.iso`,
        {
          method: 'POST',
          headers: {
            cookie,
            'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
            'content-length': String(body.length),
          },
          // Deliberately not `connection: close` -- asking the server to close this connection
          // itself, before it has necessarily drained the rest of this request's own body, risks
          // exactly the "early reply gets discarded by a TCP reset" failure mode this fix is
          // about (see `stream-early-reply.test.ts` in `packages/pve-api`), just one hop over.
          // Default keep-alive is safe either side; this test closes its *own* end explicitly
          // below, once it already has the full response in hand.
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            // Closes the client's own end of this connection now that the response is fully read
            // -- otherwise Node's keep-alive agent holds the socket open and `afterEach`'s
            // `app.close()` hangs waiting for it.
            req.destroy();
            resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  function uploadRequest(
    node: string,
    storage: string,
    query: string,
    body: Buffer | Readable,
    options: { cookie?: string; contentLength?: number | string; extraHeaders?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
    if (options.cookie !== undefined) headers.cookie = options.cookie;
    if (options.contentLength !== undefined) headers['content-length'] = String(options.contentLength);
    if (options.extraHeaders) Object.assign(headers, options.extraHeaders);
    const injectOptions: InjectOptions = {
      method: 'POST',
      url: `/api/actions/storage/${node}/${storage}/upload?${query}`,
      headers,
      payload: body,
    };
    return app.inject(injectOptions);
  }

  function downloadUrlRequest(node: string, storage: string, payload: Record<string, unknown>, cookie?: string) {
    const injectOptions: InjectOptions = {
      method: 'POST',
      url: `/api/actions/storage/${node}/${storage}/download-url`,
      payload,
    };
    if (cookie !== undefined) injectOptions.headers = { cookie };
    return app.inject(injectOptions);
  }

  function queryUrlMetadataRequest(node: string, url: string, cookie?: string) {
    const injectOptions: InjectOptions = {
      method: 'GET',
      url: `/api/actions/storage/${node}/query-url-metadata?url=${encodeURIComponent(url)}`,
    };
    if (cookie !== undefined) injectOptions.headers = { cookie };
    return app.inject(injectOptions);
  }

  function deleteContentRequest(node: string, storage: string, volid: string, vmid: number | undefined, cookie?: string) {
    const query = vmid !== undefined ? `?vmid=${vmid}` : '';
    const injectOptions: InjectOptions = {
      method: 'DELETE',
      url: `/api/actions/storage/${node}/${storage}/content/${encodeURIComponent(volid)}${query}`,
    };
    if (cookie !== undefined) injectOptions.headers = { cookie };
    return app.inject(injectOptions);
  }

  describe('upload', () => {
    it('403s in token mode', async () => {
      await setupTokenMode();
      const body = buildMultipartBody({ content: 'iso', filename: 'a.iso' }, Buffer.from('x'));
      const res = await uploadRequest('pve1', 'local', 'content=iso&filename=a.iso', body);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      expect(fakePve.uploadCalls).toHaveLength(0);
    });

    it('403s a session that lacks Datastore.AllocateTemplate', async () => {
      const cookie = await setupSession();
      const body = buildMultipartBody({ content: 'iso', filename: 'a.iso' }, Buffer.from('x'));
      const res = await uploadRequest('pve1', 'local', 'content=iso&filename=a.iso', body, { cookie });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'Datastore.AllocateTemplate' });
      expect(fakePve.uploadCalls).toHaveLength(0);
    });

    it('400s an invalid content/filename', async () => {
      const cookie = await setupSession();
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateTemplate': true });
      const body = buildMultipartBody({ content: 'iso', filename: 'a.iso' }, Buffer.from('x'));

      const badContent = await uploadRequest('pve1', 'local', 'content=vmdk&filename=a.iso', body, { cookie });
      expect(badContent.statusCode).toBe(400);

      const badFilename = await uploadRequest('pve1', 'local', 'content=iso&filename=..%2Fa.iso', body, { cookie });
      expect(badFilename.statusCode).toBe(400);

      expect(fakePve.uploadCalls).toHaveLength(0);
    });

    it('400s an extension that does not match the content type, without ever calling PVE (T34)', async () => {
      const cookie = await setupSession();
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateTemplate': true });

      const isoOk = await uploadRequest(
        'pve1',
        'local',
        'content=iso&filename=debian.iso',
        buildMultipartBody({ content: 'iso', filename: 'debian.iso' }, Buffer.from('x')),
        { cookie },
      );
      expect(isoOk.statusCode).not.toBe(400);

      const isoImgOk = await uploadRequest(
        'pve1',
        'local',
        'content=iso&filename=debian.img',
        buildMultipartBody({ content: 'iso', filename: 'debian.img' }, Buffer.from('x')),
        { cookie },
      );
      expect(isoImgOk.statusCode).not.toBe(400);

      const isoBad = await uploadRequest(
        'pve1',
        'local',
        'content=iso&filename=debian.txt',
        buildMultipartBody({ content: 'iso', filename: 'debian.txt' }, Buffer.from('x')),
        { cookie },
      );
      expect(isoBad.statusCode).toBe(400);
      expect(isoBad.json()).toEqual({ error: 'invalid-filename', message: 'ISO images must end in .iso or .img' });

      const vztmplOk = await uploadRequest(
        'pve1',
        'local',
        'content=vztmpl&filename=debian.tar.zst',
        buildMultipartBody({ content: 'vztmpl', filename: 'debian.tar.zst' }, Buffer.from('x')),
        { cookie },
      );
      expect(vztmplOk.statusCode).not.toBe(400);

      const vztmplBad = await uploadRequest(
        'pve1',
        'local',
        'content=vztmpl&filename=debian.zip',
        buildMultipartBody({ content: 'vztmpl', filename: 'debian.zip' }, Buffer.from('x')),
        { cookie },
      );
      expect(vztmplBad.statusCode).toBe(400);
      expect(vztmplBad.json()).toEqual({
        error: 'invalid-filename',
        message: 'Container templates must end in .tar.gz, .tar.xz or .tar.zst',
      });

      const importOk = await uploadRequest(
        'pve1',
        'local',
        'content=import&filename=appliance.ova',
        buildMultipartBody({ content: 'import', filename: 'appliance.ova' }, Buffer.from('x')),
        { cookie },
      );
      expect(importOk.statusCode).not.toBe(400);

      const importBad = await uploadRequest(
        'pve1',
        'local',
        'content=import&filename=appliance.iso',
        buildMultipartBody({ content: 'import', filename: 'appliance.iso' }, Buffer.from('x')),
        { cookie },
      );
      expect(importBad.statusCode).toBe(400);
      expect(importBad.json()).toEqual({
        error: 'invalid-filename',
        message: 'Import files must end in .ova, .qcow2, .raw or .vmdk',
      });

      // Only the four accepted-extension requests above ever reached PVE.
      expect(fakePve.uploadCalls).toHaveLength(4);
    });

    it('411s when Content-Length is missing', async () => {
      const cookie = await setupSession();
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateTemplate': true });

      // A stream payload (not a Buffer/string) makes light-my-request skip its own automatic
      // content-length -- exactly the "browser sent no length" case this checks for.
      const stream = Readable.from([Buffer.from('x')]);
      const res = await uploadRequest('pve1', 'local', 'content=iso&filename=a.iso', stream, { cookie });

      expect(res.statusCode).toBe(411);
      expect(res.json()).toEqual({ error: 'length-required' });
      expect(fakePve.uploadCalls).toHaveLength(0);
    });

    it('413s a Content-Length over PROXION_UPLOAD_MAX_BYTES, without ever calling PVE', async () => {
      const cookie = await setupSession({ PROXION_UPLOAD_MAX_BYTES: '10' });
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateTemplate': true });
      const body = buildMultipartBody({ content: 'iso', filename: 'a.iso' }, Buffer.alloc(1024, 1));

      const res = await uploadRequest('pve1', 'local', 'content=iso&filename=a.iso', body, { cookie });

      expect(res.statusCode).toBe(413);
      expect(res.json()).toMatchObject({ error: 'payload-too-large' });
      expect(fakePve.uploadCalls).toHaveLength(0);
    });

    it('400s a fractional Content-Length ("5.5"), without ever calling PVE', async () => {
      const cookie = await setupSession();
      const body = buildMultipartBody({ content: 'iso', filename: 'a.iso' }, Buffer.from('x'));

      const res = await uploadRequest('pve1', 'local', 'content=iso&filename=a.iso', body, {
        cookie,
        contentLength: '5.5',
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid-content-length' });
      expect(fakePve.uploadCalls).toHaveLength(0);
    });

    it('400s a non-numeric Content-Length ("abc"), without ever calling PVE', async () => {
      const cookie = await setupSession();
      const body = buildMultipartBody({ content: 'iso', filename: 'a.iso' }, Buffer.from('x'));

      const res = await uploadRequest('pve1', 'local', 'content=iso&filename=a.iso', body, {
        cookie,
        contentLength: 'abc',
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid-content-length' });
      expect(fakePve.uploadCalls).toHaveLength(0);
    });

    it('forwards a 3MB multipart body byte-exact, with the same Content-Type, and returns 202 {upid}', async () => {
      const cookie = await setupSession();
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateTemplate': true });
      const body = buildMultipartBody({ content: 'iso', filename: 'big.iso' }, Buffer.alloc(3 * 1024 * 1024, 7));

      const res = await uploadRequest('pve1', 'local', 'content=iso&filename=big.iso', body, { cookie });

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ upid: 'UPID:fakepve:00000001:00000000:00000000:imgcopy:0:root@pam:' });
      expect(fakePve.uploadCalls).toHaveLength(1);
      expect(fakePve.uploadCalls[0]!.contentType).toBe(`multipart/form-data; boundary=${BOUNDARY}`);
      expect(fakePve.uploadCalls[0]!.bytes).toBe(body.length);
    });

    it('forwards only the content-type/content-length/PVE-auth headers to PVE -- never the browser\'s own auth, proxy, or origin headers, and never the Proxion session cookie', async () => {
      const cookie = await setupSession();
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateTemplate': true });
      const body = buildMultipartBody({ content: 'iso', filename: 'a.iso' }, Buffer.alloc(1024, 1));

      const res = await uploadRequest('pve1', 'local', 'content=iso&filename=a.iso', body, {
        cookie,
        extraHeaders: {
          authorization: 'Bearer x',
          'x-forwarded-for': '1.2.3.4',
          'x-forwarded-proto': 'https',
          origin: 'https://evil.example.com',
          referer: 'https://evil.example.com/',
          'x-test-leak': '1',
        },
      });

      expect(res.statusCode).toBe(202);
      expect(fakePve.uploadCalls).toHaveLength(1);
      const forwarded = fakePve.uploadCalls[0]!.headers;

      // What PVE *should* see: the exact content-type (boundary intact), the exact byte count as
      // content-length, and the session's own PVE auth (a `PVEAuthCookie=...` cookie plus the
      // CSRF header) -- never the browser's session cookie by name.
      expect(forwarded['content-type']).toBe(`multipart/form-data; boundary=${BOUNDARY}`);
      expect(forwarded['content-length']).toBe(String(body.length));
      expect(String(forwarded.cookie)).toMatch(/^PVEAuthCookie=/);
      expect(String(forwarded.cookie)).not.toContain('proxion.sid');
      expect(forwarded.csrfpreventiontoken).toBeTruthy();

      // What PVE should never see: any of the browser's own auth/proxy/origin headers, or an
      // arbitrary custom header -- `uploadStream`'s own `headers` option only ever sets
      // `content-type` (see `storageRoutes.ts`), so none of these are ever copied through.
      expect(forwarded.authorization).toBeUndefined();
      expect(forwarded['x-forwarded-for']).toBeUndefined();
      expect(forwarded['x-forwarded-proto']).toBeUndefined();
      expect(forwarded.origin).toBeUndefined();
      expect(forwarded.referer).toBeUndefined();
      expect(forwarded['x-test-leak']).toBeUndefined();

      // T35 item 6: a stream body with an explicit `content-length` keeps content-length framing
      // all the way to PVE -- undici parses that header into its own internal `contentLength` and
      // threads it straight through (`node_modules/undici/lib/core/request.js`'s header
      // processing, `lib/dispatcher/client-h1.js`'s `AsyncWriter.write()`), only ever falling back
      // to `transfer-encoding: chunked` when no content-length was given at all. PVE's own
      // pveproxy requires `Content-Length` on uploads, so this route must never let it disappear.
      expect(forwarded['transfer-encoding']).toBeUndefined();
    });

    it('a browser-shaped body (T35 layout: the file part named `filename`) reaches PVE with that exact part order', async () => {
      const cookie = await setupSession();
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateTemplate': true });
      const body = buildMultipartBody({ content: 'iso', filename: 'debian.iso' }, Buffer.alloc(1024, 1));

      const res = await uploadRequest('pve1', 'local', 'content=iso&filename=debian.iso', body, { cookie });

      expect(res.statusCode).toBe(202);
      expect(fakePve.uploadCalls).toHaveLength(1);
      expect(fakePve.uploadCalls[0]!.parts).toEqual([{ name: 'content' }, { name: 'filename', filename: 'debian.iso' }]);
    });

    it('the OLD layout (a text `filename` field plus a `file` part) is rejected by real Proxmox\'s own multipart parser -- reproduced here via the fake\'s strict check (T35)', async () => {
      const cookie = await setupSession();
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateTemplate': true });
      const body = buildLegacyMultipartBody({ content: 'iso', filename: 'debian.iso' }, Buffer.alloc(1024, 1));

      const res = await uploadRequest('pve1', 'local', 'content=iso&filename=debian.iso', body, { cookie });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'pve-rejected',
        message: "wrong field name 'file' for file upload, expected 'filename'",
      });
    });

    it('surfaces Proxmox\'s real early reply (401, before Proxmox ever reads the body) instead of "Proxmox VE is unreachable" (T35)', async () => {
      const cookie = await setupSession();
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateTemplate': true });
      fakePve.setUploadError('local', 401, 'authentication failure');

      // A real socket end to end (see `realSocketUploadRequest`'s own comment) with a body large
      // enough that Proxmox's early reply genuinely arrives well before the browser would have
      // finished sending -- the exact shape of the production incident (a 2.9 GiB upload), just
      // smaller.
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      const body = buildMultipartBody({ content: 'iso', filename: 'big.iso' }, Buffer.alloc(10 * 1024 * 1024, 9));

      const res = await realSocketUploadRequest(address, cookie, body);
      // Node keeps this connection idle rather than closing it outright once the response is
      // read (the client-side `req.destroy()` above races the connection's return to the
      // `Agent`'s keep-alive pool) -- force it closed so `afterEach`'s `app.close()` doesn't hang
      // waiting for an idle socket nothing will ever use again.
      app.server.closeAllConnections();

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: 'pve-rejected', message: 'authentication failure' });

      // The server is still alive and correctly routing afterwards -- the whole point of this
      // fix is that Proxmox's early reply no longer takes the in-flight request down with it.
      const followUp = await queryUrlMetadataRequest('pve1', 'https://example.com/x.iso', cookie);
      expect(followUp.statusCode).toBe(200);
    }, 10_000);

    it('surfaces Proxmox\'s real early reply (413, before Proxmox ever reads the body) instead of "Proxmox VE is unreachable" (T35)', async () => {
      // A 4xx (client-error) PVE rejection, same as the 401 case above -- deliberately not a 5xx:
      // every other guest-action route already maps a genuine PVE 5xx to a generic 502
      // "pve-unreachable" on purpose (no PVE-internal detail leaked for a server-side failure;
      // see e.g. `actions.test.ts`'s "maps a PVE 5xx to 502 pve-unreachable" test) -- this route
      // reuses that same `sendPveError` convention (T35 item 3: "exactly like the other routes"),
      // so a 5xx here would still 502 by design. What T35 fixes is PVE replies getting discarded
      // by this route's *own* abort logic, not that 5xx convention.
      const cookie = await setupSession();
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateTemplate': true });
      fakePve.setUploadError('local', 413, 'for data too large');

      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      const body = buildMultipartBody({ content: 'iso', filename: 'big.iso' }, Buffer.alloc(10 * 1024 * 1024, 9));

      const res = await realSocketUploadRequest(address, cookie, body);
      app.server.closeAllConnections();

      expect(res.statusCode).toBe(413);
      expect(JSON.parse(res.body)).toEqual({ error: 'pve-rejected', message: 'for data too large' });

      const followUp = await queryUrlMetadataRequest('pve1', 'https://example.com/x.iso', cookie);
      expect(followUp.statusCode).toBe(200);
    }, 10_000);

    it('a client abort mid-upload does not crash the server', async () => {
      const cookie = await setupSession();
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateTemplate': true });

      // A real socket (not `app.inject()`'s in-process request, which wraps the payload one level
      // below where `req.raw`'s own `aborted`/`close` events fire) so the client-disconnect path
      // this route actually wires up (`req.raw.once('aborted', ...)`/`once('close', ...)`) is
      // exercised for real: this opens a real listener, sends a real request declaring a much
      // larger body than it ever finishes sending, then destroys the client-side socket mid-write
      // -- exactly what a browser tab closing or a cancelled upload looks like from the server's
      // side.
      const address = await app.listen({ port: 0, host: '127.0.0.1' });

      await new Promise<void>((resolve) => {
        const req = http.request(
          `${address}/api/actions/storage/pve1/local/upload?content=iso&filename=a.iso`,
          {
            method: 'POST',
            headers: {
              cookie,
              'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
              'content-length': String(5 * 1024 * 1024),
            },
          },
        );
        // Destroying our own request naturally errors it client-side -- expected, not the thing
        // under test (the server side is).
        req.on('error', () => {});
        req.write(Buffer.alloc(4096, 1));
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 50);
      });

      // Give the server a moment to notice the disconnect and settle its abort handling, then
      // prove it's still alive and correctly routing -- a fresh, unrelated request still succeeds.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const followUp = await queryUrlMetadataRequest('pve1', 'https://example.com/x.iso', cookie);
      expect(followUp.statusCode).toBe(200);
    });
  });

  describe('download-url', () => {
    it('403s in token mode', async () => {
      await setupTokenMode();
      const res = await downloadUrlRequest('pve1', 'local', {
        url: 'https://example.com/debian.iso',
        content: 'iso',
        filename: 'debian.iso',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
    });

    it('403s a session that lacks Datastore.AllocateTemplate', async () => {
      const cookie = await setupSession();
      const res = await downloadUrlRequest(
        'pve1',
        'local',
        { url: 'https://example.com/debian.iso', content: 'iso', filename: 'debian.iso' },
        cookie,
      );
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'Datastore.AllocateTemplate' });
    });

    it('400s a non-http(s) URL scheme', async () => {
      const cookie = await setupSession();
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateTemplate': true });
      const res = await downloadUrlRequest(
        'pve1',
        'local',
        { url: 'ftp://example.com/debian.iso', content: 'iso', filename: 'debian.iso' },
        cookie,
      );
      expect(res.statusCode).toBe(400);
    });

    it('400s an extension that does not match the content type, without ever calling PVE (T34)', async () => {
      const cookie = await setupSession();
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateTemplate': true });

      const isoOk = await downloadUrlRequest(
        'pve1',
        'local',
        { url: 'https://example.com/debian.iso', content: 'iso', filename: 'debian.iso' },
        cookie,
      );
      expect(isoOk.statusCode).not.toBe(400);

      const isoImgOk = await downloadUrlRequest(
        'pve1',
        'local',
        { url: 'https://example.com/debian.img', content: 'iso', filename: 'debian.img' },
        cookie,
      );
      expect(isoImgOk.statusCode).not.toBe(400);

      // The production bug this ticket fixes: "download from URL", content type ISO, a filename
      // with no extension at all (e.g. "bookworm").
      const isoNoExtension = await downloadUrlRequest(
        'pve1',
        'local',
        { url: 'https://example.com/bookworm', content: 'iso', filename: 'bookworm' },
        cookie,
      );
      expect(isoNoExtension.statusCode).toBe(400);
      expect(isoNoExtension.json()).toEqual({ error: 'invalid-filename', message: 'ISO images must end in .iso or .img' });

      const vztmplOk = await downloadUrlRequest(
        'pve1',
        'local',
        { url: 'https://example.com/debian.tar.zst', content: 'vztmpl', filename: 'debian.tar.zst' },
        cookie,
      );
      expect(vztmplOk.statusCode).not.toBe(400);

      const vztmplBad = await downloadUrlRequest(
        'pve1',
        'local',
        { url: 'https://example.com/debian.zip', content: 'vztmpl', filename: 'debian.zip' },
        cookie,
      );
      expect(vztmplBad.statusCode).toBe(400);
      expect(vztmplBad.json()).toEqual({
        error: 'invalid-filename',
        message: 'Container templates must end in .tar.gz, .tar.xz or .tar.zst',
      });

      const importOk = await downloadUrlRequest(
        'pve1',
        'local',
        { url: 'https://example.com/appliance.ova', content: 'import', filename: 'appliance.ova' },
        cookie,
      );
      expect(importOk.statusCode).not.toBe(400);

      const importBad = await downloadUrlRequest(
        'pve1',
        'local',
        { url: 'https://example.com/appliance.iso', content: 'import', filename: 'appliance.iso' },
        cookie,
      );
      expect(importBad.statusCode).toBe(400);
      expect(importBad.json()).toEqual({
        error: 'invalid-filename',
        message: 'Import files must end in .ova, .qcow2, .raw or .vmdk',
      });

      // Only the four accepted-extension requests above ever reached PVE.
      expect(fakePve.downloadUrlCalls).toHaveLength(4);
    });

    it('surfaces PVE\'s per-field "errors" map appended to the message (T34)', async () => {
      const cookie = await setupSession();
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateTemplate': true });
      // A filename that passes this server's own extension check (so the request actually reaches
      // PVE) but that the fake PVE itself rejects with a field-level detail, same envelope shape
      // real PVE uses (`{ message, errors }`).
      fakePve.setDownloadUrlError('local', 400, 'Parameter verification failed.', {
        filename: 'value does not match the regex pattern',
      });

      const res = await downloadUrlRequest(
        'pve1',
        'local',
        { url: 'https://example.com/debian.iso', content: 'iso', filename: 'debian.iso' },
        cookie,
      );

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'pve-rejected',
        message: 'Parameter verification failed. filename: value does not match the regex pattern',
      });
    });

    it('maps checksum/checksumAlgorithm/verifyCertificates to PVE field names', async () => {
      const cookie = await setupSession();
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateTemplate': true });

      const res = await downloadUrlRequest(
        'pve1',
        'local',
        {
          url: 'https://example.com/debian.iso',
          content: 'iso',
          filename: 'debian.iso',
          checksum: 'deadbeef',
          checksumAlgorithm: 'sha256',
          verifyCertificates: false,
        },
        cookie,
      );

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ upid: 'UPID:fakepve:00000001:00000000:00000000:download:0:root@pam:' });
      expect(fakePve.downloadUrlCalls).toHaveLength(1);
      const body = fakePve.downloadUrlCalls[0]!.body;
      expect(body.url).toBe('https://example.com/debian.iso');
      expect(body.content).toBe('iso');
      expect(body.filename).toBe('debian.iso');
      expect(body.checksum).toBe('deadbeef');
      expect(body['checksum-algorithm']).toBe('sha256');
      expect(body['verify-certificates']).toBe('0');
    });

    it('surfaces a PVE rejection via sendPveError', async () => {
      const cookie = await setupSession();
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateTemplate': true });
      // A filename that passes this server's own extension check (T34 added that check *before*
      // any PVE call) -- what's under test here is a PVE-side rejection for some other reason,
      // surfaced verbatim via `sendPveError`.
      fakePve.setDownloadUrlError('local', 400, 'unsupported file extension');

      const res = await downloadUrlRequest(
        'pve1',
        'local',
        { url: 'https://example.com/debian.iso', content: 'iso', filename: 'debian.iso' },
        cookie,
      );

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'pve-rejected', message: 'unsupported file extension' });
    });
  });

  describe('query-url-metadata', () => {
    it('403s in token mode', async () => {
      await setupTokenMode();
      const res = await queryUrlMetadataRequest('pve1', 'https://example.com/debian.iso');
      expect(res.statusCode).toBe(403);
    });

    it('400s a non-http(s) URL scheme', async () => {
      const cookie = await setupSession();
      const res = await queryUrlMetadataRequest('pve1', 'ftp://example.com/debian.iso', cookie);
      expect(res.statusCode).toBe(400);
    });

    it('proxies PVE\'s response verbatim', async () => {
      const cookie = await setupSession();
      fakePve.setQueryUrlMetadata({ filename: 'debian.iso', size: 123456, mimetype: 'application/octet-stream' });

      const res = await queryUrlMetadataRequest('pve1', 'https://example.com/debian.iso', cookie);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ filename: 'debian.iso', size: 123456, mimetype: 'application/octet-stream' });
      expect(fakePve.queryUrlMetadataCalls).toHaveLength(1);
    });
  });

  describe('content delete', () => {
    it('403s in token mode', async () => {
      await setupTokenMode();
      const res = await deleteContentRequest('pve1', 'local', 'local:iso/x.iso', undefined);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
    });

    it('403s a session with no Datastore.Allocate and no vmid', async () => {
      const cookie = await setupSession();
      const res = await deleteContentRequest('pve1', 'local', 'local:iso/x.iso', undefined, cookie);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'Datastore.Allocate' });
    });

    it('400s a volid whose storage prefix does not match the route storage', async () => {
      const cookie = await setupSession();
      fakePve.setStoragePermissions('local', { 'Datastore.Allocate': true });
      const res = await deleteContentRequest('pve1', 'local', 'other:iso/x.iso', undefined, cookie);
      expect(res.statusCode).toBe(400);
    });

    it('400s (never 500) a raw "%25" volid segment -- Fastify already decodes route params once, so a second decode of the resulting bare "%" used to throw URIError before validation/auth ever ran', async () => {
      const cookie = await setupSession();
      // Built by hand, not `deleteContentRequest` (which itself `encodeURIComponent`s its `volid`
      // argument) -- the wire path segment must be the literal three characters `%25`, which
      // Fastify's own single decode turns into a bare `%` for `routeParams.volid`.
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/actions/storage/pve1/local/content/%25',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400s (never 500) a volid containing a stray "%" once decoded', async () => {
      const cookie = await setupSession();
      // Wire segment `local%3Afoo%2525bar` -- Fastify's single decode turns `%3A` into `:` and
      // `%25` into `%`, leaving the literal (non-escape) substring `25` untouched, so
      // `routeParams.volid` is `local:foo%25bar` -- a decoded value containing a bare `%` that
      // `volidSchema` rejects (no `%` in its allowed character class), same as any other
      // malformed volid.
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/actions/storage/pve1/local/content/local%3Afoo%2525bar',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
    });

    it('Datastore.Allocate alone is sufficient (no vmid needed)', async () => {
      const cookie = await setupSession();
      fakePve.setStoragePermissions('local', { 'Datastore.Allocate': true });

      const res = await deleteContentRequest('pve1', 'local', 'local:iso/x.iso', undefined, cookie);

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ upid: 'UPID:fakepve:00000001:00000000:00000000:imgdel:0:root@pam:' });
      expect(fakePve.deleteContentCalls).toEqual([{ storage: 'local', volume: 'local:iso/x.iso' }]);
    });

    it('Datastore.AllocateSpace + VM.Backup only succeeds when vmid is given', async () => {
      const cookie = await setupSession();
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateSpace': true });
      fakePve.setVmPermissions(100, { 'VM.Backup': true });

      const withoutVmid = await deleteContentRequest('pve1', 'local', 'local:backup/vzdump-100.vma.zst', undefined, cookie);
      expect(withoutVmid.statusCode).toBe(403);

      const withVmid = await deleteContentRequest('pve1', 'local', 'local:backup/vzdump-100.vma.zst', 100, cookie);
      expect(withVmid.statusCode).toBe(202);
      expect(fakePve.deleteContentCalls).toEqual([{ storage: 'local', volume: 'local:backup/vzdump-100.vma.zst' }]);
    });

    it('surfaces a PVE rejection (e.g. protected) via sendPveError', async () => {
      const cookie = await setupSession();
      fakePve.setStoragePermissions('local', { 'Datastore.Allocate': true });
      fakePve.setDeleteContentError('local', 'local:backup/protected.vma.zst', 403, 'backup is protected');

      const res = await deleteContentRequest('pve1', 'local', 'local:backup/protected.vma.zst', undefined, cookie);

      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'pve-rejected', message: 'backup is protected' });
    });
  });
});
