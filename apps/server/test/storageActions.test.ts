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

  /** Builds a real multipart/form-data body: `content`, `filename`, then the `file` part, in that
   * order -- same field order the web client builds (`api/actions.ts`'s `uploadToStorage`). */
  function buildMultipartBody(fields: { content: string; filename: string }, fileBytes: Buffer): Buffer {
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

  function uploadRequest(
    node: string,
    storage: string,
    query: string,
    body: Buffer | Readable,
    options: { cookie?: string; contentLength?: number } = {},
  ) {
    const headers: Record<string, string> = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
    if (options.cookie !== undefined) headers.cookie = options.cookie;
    if (options.contentLength !== undefined) headers['content-length'] = String(options.contentLength);
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
      fakePve.setDownloadUrlError('local', 400, 'unsupported file extension');

      const res = await downloadUrlRequest(
        'pve1',
        'local',
        { url: 'https://example.com/debian.exe', content: 'iso', filename: 'debian.exe' },
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
