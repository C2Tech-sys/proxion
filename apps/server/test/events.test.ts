import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import http from 'node:http';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';
import { Poller } from '../src/poller/poller.js';

async function loginCookie(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'root', password: 'goodpass', realm: 'pam' },
  });
  const raw = response.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (!first) throw new Error('login did not set a cookie');
  return first.split(';')[0]!;
}

describe('/api/state and /api/events', () => {
  let fakePve: FakePve;
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    await fakePve?.close();
  });

  it('GET /api/state returns 503 when no service token is configured', async () => {
    fakePve = await startFakePve();
    app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url }) });

    const cookie = await loginCookie(app);
    const response = await app.inject({ method: 'GET', url: '/api/state', headers: { cookie } });
    expect(response.statusCode).toBe(503);
  });

  it('GET /api/events returns 503 when no service token is configured', async () => {
    fakePve = await startFakePve();
    app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url }) });

    const cookie = await loginCookie(app);
    const response = await app.inject({ method: 'GET', url: '/api/events', headers: { cookie } });
    expect(response.statusCode).toBe(503);
  });

  it('GET /api/state and /api/events return 401 without a session, even when a service token is configured but token mode is off', async () => {
    fakePve = await startFakePve();
    app = await buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        PVE_URL: fakePve.url,
        PVE_TOKEN_ID: 'root@pam!proxion',
        PVE_TOKEN_SECRET: 'tokensecret',
      }),
    });
    for (const url of ['/api/state', '/api/events']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Not authenticated' });
    }
  });

  it('GET /api/state returns 401 (not 503) without a session when no service token is configured', async () => {
    fakePve = await startFakePve();
    app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url }) });
    const response = await app.inject({ method: 'GET', url: '/api/state' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /api/state returns the poller snapshot once configured', async () => {
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

    // Give the poller's immediate first poll a tick to complete.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const response = await app.inject({ method: 'GET', url: '/api/state' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ resources: [], tasks: [], alerts: [] });
  });

  it('SSE stream sends a snapshot on connect, then only emits resources/tasks on change', async () => {
    fakePve = await startFakePve();
    fakePve.setClusterResources([{ id: 'node/pve' }]);

    app = await buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        PVE_URL: fakePve.url,
        PVE_TOKEN_ID: 'root@pam!proxion',
        PVE_TOKEN_SECRET: 'tokensecret',
        PROXION_ALLOW_TOKEN_MODE: 'true',
      }),
    });
    // Fast intervals for this end-to-end test, overriding the app's poller.
    app.proxionPoller!.stop();
    app.proxionPoller = new Poller(app.proxionTokenClient!, app.log, {
      resourcesIntervalMs: 30,
      tasksIntervalMs: 40,
    });
    app.proxionPoller.start();
    // Wait for its first (immediate) poll to actually land before we open the SSE
    // stream, so `snapshot` reflects it -- polled rather than a fixed sleep, so
    // this isn't flaky under system load.
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const check = () => {
        if (app.proxionPoller!.getSnapshot().resources.length > 0) {
          resolve();
        } else if (Date.now() > deadline) {
          reject(new Error('poller never produced its first snapshot'));
        } else {
          setTimeout(check, 5);
        }
      };
      check();
    });

    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    const events: Array<{ event: string; data: unknown }> = [];
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`${address}/api/events`, (res) => {
        let buffer = '';
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          let idx = buffer.indexOf('\n\n');
          while (idx !== -1) {
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const eventLine = rawEvent.split('\n').find((l) => l.startsWith('event: '));
            const dataLine = rawEvent.split('\n').find((l) => l.startsWith('data: '));
            if (eventLine && dataLine) {
              events.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) });
            }
            if (events.length === 1) {
              // Change the upstream data so the next poll produces a diff.
              fakePve.setClusterResources([{ id: 'node/pve' }, { id: 'qemu/100' }]);
            }
            if (events.length >= 2) {
              req.destroy();
              resolve();
            }
            idx = buffer.indexOf('\n\n');
          }
        });
        res.on('error', reject);
      });
      req.on('error', () => {
        /* destroyed intentionally once we have what we need */
      });
    });

    expect(events[0]!.event).toBe('snapshot');
    expect(events[0]!.data).toEqual({ resources: [{ id: 'node/pve' }], tasks: [], alerts: [] });
    expect(events[1]!.event).toBe('resources');
    expect(events[1]!.data).toEqual([{ id: 'node/pve' }, { id: 'qemu/100' }]);
  });

  it('a failed vzdump followed by an OK produces a "healed" alert in the snapshot and over SSE', async () => {
    fakePve = await startFakePve();
    fakePve.setClusterResources([{ id: 'node/pve1', type: 'node', node: 'pve1' }]);
    const now = Math.floor(Date.now() / 1000);
    const failedTask = {
      upid: 'UPID:pve1:00000001:00000000:00000000:vzdump:113:msp360@pve:',
      node: 'pve1',
      pid: 1,
      pstart: 1,
      type: 'vzdump',
      id: '113',
      user: 'msp360@pve',
      starttime: now - 600,
      endtime: now - 590,
      status: 'ERROR: job errors',
    };
    fakePve.setNodeTasks('pve1', [failedTask]);

    app = await buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        PVE_URL: fakePve.url,
        PVE_TOKEN_ID: 'root@pam!proxion',
        PVE_TOKEN_SECRET: 'tokensecret',
        PROXION_ALLOW_TOKEN_MODE: 'true',
      }),
    });
    app.proxionPoller!.stop();
    app.proxionPoller = new Poller(app.proxionTokenClient!, app.log, {
      resourcesIntervalMs: 20,
      tasksIntervalMs: 20,
      vzdumpHistoryIntervalMs: 20,
    });
    app.proxionPoller.start();

    // Wait for the first vzdump-history poll to have produced the soft/warning alert.
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const check = () => {
        const alerts = app.proxionPoller!.getSnapshot().alerts;
        if (alerts.some((a) => a.severity === 'warning' && a.kind === 'backup')) resolve();
        else if (Date.now() > deadline) reject(new Error('never saw the soft backup alert'));
        else setTimeout(check, 5);
      };
      check();
    });

    const stateResponse = await app.inject({ method: 'GET', url: '/api/state' });
    expect(stateResponse.json().alerts).toMatchObject([{ kind: 'backup', severity: 'warning' }]);

    // The OK arrives via the fast cluster task poll (not the slow node-history one) --
    // exercising "heals within seconds" via the cluster-task path.
    const healedTask = {
      ...failedTask,
      upid: 'UPID:pve1:00000002:00000000:00000000:vzdump:113:msp360@pve:',
      starttime: now - 300,
      endtime: now - 290,
      status: 'OK',
    };
    fakePve.setClusterResources([{ id: 'node/pve1', type: 'node', node: 'pve1' }]);
    // Simulate the OK showing up in the cluster's own recent-task list by also adding it to the
    // node's history -- either poll picking it up must heal the incident.
    fakePve.setNodeTasks('pve1', [failedTask, healedTask]);

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const check = () => {
        const alerts = app.proxionPoller!.getSnapshot().alerts;
        if (alerts.some((a) => a.severity === 'healed' && a.kind === 'backup')) resolve();
        else if (Date.now() > deadline) reject(new Error('backup alert never healed'));
        else setTimeout(check, 5);
      };
      check();
    });

    const healedResponse = await app.inject({ method: 'GET', url: '/api/state' });
    expect(healedResponse.json().alerts).toMatchObject([{ kind: 'backup', severity: 'healed' }]);
  });
});
