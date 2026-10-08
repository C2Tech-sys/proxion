import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger, FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

const BASE = '/api/actions/node/pve1/system';
type HttpMethod = NonNullable<InjectOptions['method']>;

const KEY_BODY = 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgTOPSECRETKEYMATERIAL0123456789';
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n-----END PRIVATE KEY-----\n`;
const CERT_CHAIN = '-----BEGIN CERTIFICATE-----\nMIIBFAKECERTIFICATE\n-----END CERTIFICATE-----\n';

describe('node system routes (T71)', () => {
  let fakePve: FakePve;
  let app: FastifyInstance;

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await fakePve?.close();
  });

  async function setupSession(): Promise<string> {
    fakePve = await startFakePve();
    app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url }) });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root', password: 'goodpass', realm: 'pam' },
    });
    const setCookie = login.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!raw) throw new Error('login did not set a session cookie');
    fakePve.setNodePermissions('pve1', { 'Sys.Modify': true });
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

  function call(method: HttpMethod, path: string, cookie?: string, payload?: unknown) {
    const options: InjectOptions = { method, url: `${BASE}${path}` };
    if (cookie !== undefined) options.headers = { cookie };
    if (payload !== undefined) options.payload = payload as NonNullable<InjectOptions['payload']>;
    return app.inject(options);
  }

  async function expect400(method: HttpMethod, path: string, cookie: string, payload: unknown) {
    const res = await call(method, path, cookie, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'Invalid request body' });
    expect(fakePve.systemCalls).toHaveLength(0);
    return res;
  }

  const ALL_WRITES: Array<[HttpMethod, string, unknown]> = [
    ['PUT', '/dns', { search: 'lab.local', dns1: '10.0.0.1' }],
    ['PUT', '/time', { timezone: 'Europe/Berlin' }],
    ['PUT', '/options', { wakeonlan: 'aa:bb:cc:dd:ee:ff' }],
    ['POST', '/hosts', { data: '127.0.0.1 localhost\n' }],
    ['POST', '/certificates', { certificates: CERT_CHAIN, key: PRIVATE_KEY }],
    ['DELETE', '/certificates', { restart: false }],
  ];

  describe('gating', () => {
    it('403s every write in token mode before any PVE call', async () => {
      await setupTokenMode();
      for (const [method, path, payload] of ALL_WRITES) {
        const res = await call(method, path, undefined, payload);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      }
      // The only PVE traffic token mode may see is the background poller's own cluster reads.
      expect(fakePve.systemCalls).toHaveLength(0);
      const last = fakePve.lastRequestUrl;
      expect(last === undefined || last.startsWith('/api2/json/cluster/')).toBe(true);
    });

    it('401s every write without a session', async () => {
      await setupSession();
      for (const [method, path, payload] of ALL_WRITES) {
        const res = await call(method, path, undefined, payload);
        expect(res.statusCode).toBe(401);
      }
      expect(fakePve.systemCalls).toHaveLength(0);
    });

    it('403s without Sys.Modify on the node, naming the missing privilege', async () => {
      const cookie = await setupSession();
      fakePve.setNodePermissions('pve1', { 'Sys.Audit': true });
      for (const [method, path, payload] of ALL_WRITES) {
        const res = await call(method, path, cookie, payload);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden', missing: 'Sys.Modify' });
      }
      expect(fakePve.systemCalls).toHaveLength(0);
    });

    it('rejects an invalid node name with 400', async () => {
      const cookie = await setupSession();
      const res = await app.inject({
        method: 'PUT',
        url: '/api/actions/node/-bad_node/system/time',
        headers: { cookie },
        payload: { timezone: 'UTC' },
      });
      expect(res.statusCode).toBe(400);
      expect(fakePve.systemCalls).toHaveLength(0);
    });

    it('reads dns, time, config, hosts and certificate info through the read-only proxy', async () => {
      const cookie = await setupSession();
      const read = async (path: string) =>
        (await app.inject({ method: 'GET', url: `/api/pve/nodes/pve1/${path}`, headers: { cookie } })).json();
      expect((await read('dns')).data).toMatchObject({ search: 'lab.local', dns1: '10.0.0.1' });
      expect((await read('time')).data).toMatchObject({ timezone: 'America/Chicago' });
      expect((await read('config')).data).toMatchObject({ digest: 'cfgdigest' });
      expect((await read('hosts')).data).toMatchObject({ digest: 'hostsdigest' });
      expect((await read('certificates/info')).data[0]).toMatchObject({ filename: 'pve-ssl.pem' });
    });
  });

  describe('dns', () => {
    it('sends search and the set servers, leaving a cleared server out', async () => {
      const cookie = await setupSession();
      const res = await call('PUT', '/dns', cookie, { search: 'lab.local', dns1: '10.0.0.1', dns2: '1.1.1.1', dns3: null });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(fakePve.systemCalls).toHaveLength(1);
      expect(fakePve.systemCalls[0]).toStrictEqual({
        method: 'PUT',
        path: '/api2/json/nodes/pve1/dns',
        body: { search: 'lab.local', dns1: '10.0.0.1', dns2: '1.1.1.1' },
      });
    });

    it('accepts an IPv6 server', async () => {
      const cookie = await setupSession();
      const res = await call('PUT', '/dns', cookie, { search: 'lab.local', dns1: '2606:4700:4700::1111' });
      expect(res.statusCode).toBe(200);
      expect(fakePve.systemCalls[0]!.body).toStrictEqual({ search: 'lab.local', dns1: '2606:4700:4700::1111' });
    });

    it('400s a bad IP, a zoned IPv6, a bad search domain and an unknown field', async () => {
      const cookie = await setupSession();
      await expect400('PUT', '/dns', cookie, { search: 'lab.local', dns1: '10.0.0.999' });
      await expect400('PUT', '/dns', cookie, { search: 'lab.local', dns1: 'fe80::1%eth0' });
      await expect400('PUT', '/dns', cookie, { search: 'not a domain', dns1: '10.0.0.1' });
      await expect400('PUT', '/dns', cookie, { search: `${'a'.repeat(64)}.local` });
      await expect400('PUT', '/dns', cookie, { dns1: '10.0.0.1' });
      await expect400('PUT', '/dns', cookie, { search: 'lab.local', dns4: '10.0.0.1' });
    });

    it('maps a PVE 4xx to pve-rejected and a 5xx to 502', async () => {
      const cookie = await setupSession();
      fakePve.setSystemError('dns', { status: 400, message: 'Parameter verification failed.', errors: { dns1: 'invalid' } });
      const rejected = await call('PUT', '/dns', cookie, { search: 'lab.local', dns1: '10.0.0.1' });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toEqual({ error: 'pve-rejected', message: 'Parameter verification failed. dns1: invalid' });
      fakePve.setSystemError('dns', { status: 500, message: 'boom' });
      const down = await call('PUT', '/dns', cookie, { search: 'lab.local', dns1: '10.0.0.1' });
      expect(down.statusCode).toBe(502);
      expect(down.json()).toEqual({ error: 'pve-unreachable' });
    });
  });

  describe('time', () => {
    it('sends the exact timezone body', async () => {
      const cookie = await setupSession();
      const res = await call('PUT', '/time', cookie, { timezone: 'America/Argentina/Buenos_Aires' });
      expect(res.statusCode).toBe(200);
      expect(fakePve.systemCalls[0]).toStrictEqual({
        method: 'PUT',
        path: '/api2/json/nodes/pve1/time',
        body: { timezone: 'America/Argentina/Buenos_Aires' },
      });
    });

    it('400s a timezone that does not match the pattern, is too long, or comes with extra fields', async () => {
      const cookie = await setupSession();
      await expect400('PUT', '/time', cookie, { timezone: '../etc/passwd' });
      await expect400('PUT', '/time', cookie, { timezone: 'Europe/Berlin; rm' });
      await expect400('PUT', '/time', cookie, { timezone: 'A/B/C/D' });
      await expect400('PUT', '/time', cookie, { timezone: `${'a'.repeat(65)}` });
      await expect400('PUT', '/time', cookie, { timezone: '' });
      await expect400('PUT', '/time', cookie, { timezone: 'UTC', time: 5 });
    });
  });

  describe('options', () => {
    it('sends the exact PVE body with the digest forwarded', async () => {
      const cookie = await setupSession();
      const res = await call('PUT', '/options', cookie, {
        startallOnbootDelay: 30,
        wakeonlan: 'aa:bb:cc:dd:ee:ff',
        digest: 'abc',
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.systemCalls[0]).toStrictEqual({
        method: 'PUT',
        path: '/api2/json/nodes/pve1/config',
        body: { 'startall-onboot-delay': '30', wakeonlan: 'aa:bb:cc:dd:ee:ff', digest: 'abc' },
      });
    });

    it('sends the ballooning target and a sanitized description', async () => {
      const cookie = await setupSession();
      const res = await call('PUT', '/options', cookie, { description: 'Rack 2\r\nrow\u0007 B', ballooningTarget: 80 });
      expect(res.statusCode).toBe(200);
      expect(fakePve.systemCalls[0]!.body).toStrictEqual({ description: 'Rack 2\nrow B', 'ballooning-target': '80' });
    });

    it('turns a cleared description into delete: description', async () => {
      const cookie = await setupSession();
      const res = await call('PUT', '/options', cookie, { description: null });
      expect(res.statusCode).toBe(200);
      expect(fakePve.systemCalls[0]!.body).toStrictEqual({ delete: 'description' });
    });

    it('turns every null into the delete list, and an empty description too', async () => {
      const cookie = await setupSession();
      const res = await call('PUT', '/options', cookie, {
        description: '',
        startallOnbootDelay: null,
        wakeonlan: null,
        ballooningTarget: null,
        digest: 'd1',
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.systemCalls[0]!.body).toStrictEqual({
        delete: 'description,startall-onboot-delay,ballooning-target,wakeonlan',
        digest: 'd1',
      });
    });

    it('400s a bad MAC, out-of-range numbers, an empty body, digest alone and ACME fields', async () => {
      const cookie = await setupSession();
      await expect400('PUT', '/options', cookie, { wakeonlan: 'aa:bb:cc:dd:ee' });
      await expect400('PUT', '/options', cookie, { wakeonlan: 'gg:bb:cc:dd:ee:ff' });
      await expect400('PUT', '/options', cookie, { startallOnbootDelay: 301 });
      await expect400('PUT', '/options', cookie, { startallOnbootDelay: -1 });
      await expect400('PUT', '/options', cookie, { ballooningTarget: 101 });
      await expect400('PUT', '/options', cookie, { ballooningTarget: 1.5 });
      await expect400('PUT', '/options', cookie, { description: 'x'.repeat(8193) });
      await expect400('PUT', '/options', cookie, {});
      await expect400('PUT', '/options', cookie, { digest: 'abc' });
      await expect400('PUT', '/options', cookie, { acme: 'account=default' });
      await expect400('PUT', '/options', cookie, { wakeonlan: 'aa:bb:cc:dd:ee:ff', location: 'rack' });
    });

    it('maps a PVE 4xx to pve-rejected (stale digest) and a 5xx to 502', async () => {
      const cookie = await setupSession();
      fakePve.setSystemError('options', { status: 400, message: 'detected modified configuration - file changed by other user' });
      const rejected = await call('PUT', '/options', cookie, { wakeonlan: 'aa:bb:cc:dd:ee:ff', digest: 'old' });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toMatchObject({ error: 'pve-rejected' });
      fakePve.setSystemError('options', { status: 503, message: 'down' });
      const down = await call('PUT', '/options', cookie, { wakeonlan: 'aa:bb:cc:dd:ee:ff' });
      expect(down.statusCode).toBe(502);
    });
  });

  describe('hosts', () => {
    it('sends the exact body with the digest', async () => {
      const cookie = await setupSession();
      const data = '127.0.0.1 localhost\n10.0.0.11 pve1.lab.local pve1\n';
      const res = await call('POST', '/hosts', cookie, { data, digest: 'hostsdigest' });
      expect(res.statusCode).toBe(200);
      expect(fakePve.systemCalls[0]).toStrictEqual({
        method: 'POST',
        path: '/api2/json/nodes/pve1/hosts',
        body: { data, digest: 'hostsdigest' },
      });
    });

    it('omits the digest when none is given', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '/hosts', cookie, { data: '127.0.0.1 localhost\n' });
      expect(res.statusCode).toBe(200);
      expect(fakePve.systemCalls[0]!.body).toStrictEqual({ data: '127.0.0.1 localhost\n' });
    });

    it('400s a NUL byte, an over-long line, an over-long file, empty text and extra fields', async () => {
      const cookie = await setupSession();
      await expect400('POST', '/hosts', cookie, { data: '127.0.0.1 local\u0000host\n' });
      await expect400('POST', '/hosts', cookie, { data: `127.0.0.1 ${'a'.repeat(1100)}\n` });
      await expect400('POST', '/hosts', cookie, { data: '127.0.0.1 a\n'.repeat(6000) });
      await expect400('POST', '/hosts', cookie, { data: '' });
      await expect400('POST', '/hosts', cookie, { data: '127.0.0.1 localhost\n', extra: true });
    });

    it('maps a PVE 4xx to pve-rejected and a 5xx to 502', async () => {
      const cookie = await setupSession();
      fakePve.setSystemError('hosts', { status: 400, message: 'detected modified configuration' });
      const rejected = await call('POST', '/hosts', cookie, { data: '127.0.0.1 localhost\n', digest: 'old' });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toMatchObject({ error: 'pve-rejected' });
      fakePve.setSystemError('hosts', { status: 500, message: 'boom' });
      expect((await call('POST', '/hosts', cookie, { data: '127.0.0.1 localhost\n' })).statusCode).toBe(502);
    });
  });

  describe('certificates', () => {
    it('uploads a certificate and key with the exact PVE body (restart defaults on)', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '/certificates', cookie, { certificates: CERT_CHAIN, key: PRIVATE_KEY });
      expect(res.statusCode).toBe(200);
      expect(fakePve.systemCalls).toHaveLength(1);
      expect(fakePve.systemCalls[0]).toStrictEqual({
        method: 'POST',
        path: '/api2/json/nodes/pve1/certificates/custom',
        body: { certificates: CERT_CHAIN, key: PRIVATE_KEY, restart: '1' },
      });
    });

    it('sends force: 1 and restart: 0 when asked, and leaves key out when not given', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '/certificates', cookie, { certificates: CERT_CHAIN, force: true, restart: false });
      expect(res.statusCode).toBe(200);
      expect(fakePve.systemCalls[0]!.body).toStrictEqual({ certificates: CERT_CHAIN, force: '1', restart: '0' });
    });

    it('does not send force when it is false', async () => {
      const cookie = await setupSession();
      await call('POST', '/certificates', cookie, { certificates: CERT_CHAIN, key: PRIVATE_KEY, force: false });
      expect(fakePve.systemCalls[0]!.body).toStrictEqual({ certificates: CERT_CHAIN, key: PRIVATE_KEY, restart: '1' });
    });

    it("responds with PVE's certificate info without the pem", async () => {
      const cookie = await setupSession();
      const res = await call('POST', '/certificates', cookie, { certificates: CERT_CHAIN, key: PRIVATE_KEY });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toStrictEqual({
        filename: 'pveproxy-ssl.pem',
        fingerprint: 'DD:EE:FF',
        subject: '/CN=pve1.lab.local',
        issuer: '/CN=Lab CA',
        notbefore: 1760000000,
        notafter: 1790000000,
        san: ['pve1.lab.local'],
        'public-key-type': 'id-ecPublicKey',
        'public-key-bits': 256,
      });
      expect(res.body).not.toContain('"pem"');
      expect(res.body).not.toContain('FAKECUSTOMPEM');
    });

    it('400s a chain without BEGIN CERTIFICATE and a key without a private-key header', async () => {
      const cookie = await setupSession();
      await expect400('POST', '/certificates', cookie, { certificates: 'not a pem', key: PRIVATE_KEY });
      await expect400('POST', '/certificates', cookie, { key: PRIVATE_KEY });
      await expect400('POST', '/certificates', cookie, { certificates: CERT_CHAIN, key: 'not a key' });
      await expect400('POST', '/certificates', cookie, { certificates: CERT_CHAIN, key: CERT_CHAIN });
      await expect400('POST', '/certificates', cookie, { certificates: CERT_CHAIN + 'x'.repeat(65536) });
      await expect400('POST', '/certificates', cookie, { certificates: CERT_CHAIN, extra: 1 });
    });

    it('accepts RSA and EC key headers', async () => {
      const cookie = await setupSession();
      for (const kind of ['RSA ', 'EC ']) {
        const key = `-----BEGIN ${kind}PRIVATE KEY-----\nAAAA\n-----END ${kind}PRIVATE KEY-----\n`;
        const res = await call('POST', '/certificates', cookie, { certificates: CERT_CHAIN, key });
        expect(res.statusCode).toBe(200);
      }
    });

    it('removes the custom certificate with restart: 0', async () => {
      const cookie = await setupSession();
      const res = await call('DELETE', '/certificates', cookie, { restart: false });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(fakePve.systemCalls).toHaveLength(1);
      expect(fakePve.systemCalls[0]).toStrictEqual({
        method: 'DELETE',
        path: '/api2/json/nodes/pve1/certificates/custom?restart=0',
        body: { restart: '0' },
      });
    });

    it('removes the custom certificate with restart on by default, and 400s extra fields', async () => {
      const cookie = await setupSession();
      const res = await call('DELETE', '/certificates', cookie, {});
      expect(res.statusCode).toBe(200);
      expect(fakePve.systemCalls[0]!.body).toStrictEqual({ restart: '1' });
      fakePve.systemCalls.length = 0;
      await expect400('DELETE', '/certificates', cookie, { restart: true, force: true });
    });

    it('maps a PVE 4xx to pve-rejected and a 5xx to 502, for upload and remove', async () => {
      const cookie = await setupSession();
      fakePve.setSystemError('cert-upload', { status: 400, message: 'unable to parse certificate' });
      const rejected = await call('POST', '/certificates', cookie, { certificates: CERT_CHAIN, key: PRIVATE_KEY });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toEqual({ error: 'pve-rejected', message: 'unable to parse certificate' });
      fakePve.setSystemError('cert-upload', { status: 500, message: 'boom' });
      const down = await call('POST', '/certificates', cookie, { certificates: CERT_CHAIN, key: PRIVATE_KEY });
      expect(down.statusCode).toBe(502);
      expect(down.json()).toEqual({ error: 'pve-unreachable' });

      fakePve.setSystemError('cert-delete', { status: 403, message: 'permission denied' });
      const refused = await call('DELETE', '/certificates', cookie, {});
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ error: 'pve-rejected' });
      fakePve.setSystemError('cert-delete', { status: 502, message: 'bad gateway' });
      expect((await call('DELETE', '/certificates', cookie, {})).statusCode).toBe(502);
    });
  });

  describe('the private key never reaches the logger', () => {
    /**
     * Same mechanism as `cloudInitRoutes.test.ts`: the app's logger is `silent` under
     * NODE_ENV=test, so every level method of the root logger and of every per-request child logger
     * is spied on, recording the arguments (run through the logger's own pino serializers, so it is
     * what pino would write). The control test proves the spy sees a leak.
     */
    function captureLogCalls(): unknown[][] {
      const calls: unknown[][] = [];
      const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
      const serialize = (logger: FastifyBaseLogger, args: unknown[]): unknown[] => {
        const serializers = (logger as unknown as Record<symbol, Record<string, (v: unknown) => unknown> | undefined>)[
          Symbol.for('pino.serializers')
        ];
        const [first, ...rest] = args;
        if (typeof first !== 'object' || first === null || serializers === undefined) return args;
        const written: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(first)) {
          const serializer = serializers[key];
          written[key] = serializer ? serializer(value) : value;
        }
        return [written, ...rest];
      };
      const instrument = (logger: FastifyBaseLogger) => {
        for (const level of levels) {
          const original = logger[level].bind(logger) as (...args: unknown[]) => void;
          vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
            calls.push(serialize(logger, args));
            original(...args);
          }) as never);
        }
      };
      instrument(app.log);
      const originalChild = app.log.child.bind(app.log) as (...args: unknown[]) => FastifyBaseLogger;
      vi.spyOn(app.log, 'child').mockImplementation(((...args: unknown[]) => {
        const child = originalChild(...args);
        instrument(child);
        return child;
      }) as never);
      return calls;
    }

    it('control: the capture does see a leak when a log call is handed the key', async () => {
      await setupSession();
      const calls = captureLogCalls();
      app.log.info({ body: { key: PRIVATE_KEY } }, 'deliberate leak');
      expect(calls.some((args) => JSON.stringify(args).includes(KEY_BODY))).toBe(true);
    });

    it('a successful upload logs no key text and returns none', async () => {
      const cookie = await setupSession();
      const calls = captureLogCalls();
      const res = await call('POST', '/certificates', cookie, { certificates: CERT_CHAIN, key: PRIVATE_KEY });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(KEY_BODY);
      // The key did reach PVE (the only place it should go).
      expect(fakePve.systemCalls[0]!.body.key).toBe(PRIVATE_KEY);

      const uploaded = calls.find((args) => args[1] === 'Node custom certificate uploaded');
      expect(uploaded).toBeDefined();
      expect(uploaded![0]).toMatchObject({ node: 'pve1', withKey: true });
      for (const args of calls) {
        expect(JSON.stringify(args)).not.toContain(KEY_BODY);
      }
    });

    it('PVE failures (4xx and 5xx) and a 400 never log or return the key either', async () => {
      const cookie = await setupSession();
      const calls = captureLogCalls();

      fakePve.setSystemError('cert-upload', { status: 500, message: 'boom' });
      const down = await call('POST', '/certificates', cookie, { certificates: CERT_CHAIN, key: PRIVATE_KEY });
      expect(down.statusCode).toBe(502);
      expect(down.body).not.toContain(KEY_BODY);

      fakePve.setSystemError('cert-upload', { status: 400, message: 'unable to parse private key' });
      const rejected = await call('POST', '/certificates', cookie, { certificates: CERT_CHAIN, key: PRIVATE_KEY });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.body).not.toContain(KEY_BODY);

      const invalid = await call('POST', '/certificates', cookie, { certificates: 'not a pem', key: PRIVATE_KEY });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.body).not.toContain(KEY_BODY);

      expect(calls.length).toBeGreaterThan(0);
      for (const args of calls) {
        expect(JSON.stringify(args)).not.toContain(KEY_BODY);
      }
    });
  });
});
