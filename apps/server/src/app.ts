import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import { loadConfig, type Config } from './config.js';
import './types.js';
import healthRoutes from './routes/health.js';
import authRoutes from './auth/routes.js';
import pveProxyRoutes from './proxy/pveProxy.js';
import actionsRoutes from './actions/routes.js';
import pollerRoutes from './poller/routes.js';
import consoleRoutes from './console/routes.js';
import consoleWsRoutes from './console/ws.js';
import consoleThumbnailRoutes from './console/thumbnailRoutes.js';
import prefsRoutes from './prefs/routes.js';
import { SessionStore } from './auth/sessionStore.js';
import { PrefsStore } from './prefs/store.js';
import { ConsoleTicketStore } from './console/ticketStore.js';
import { ConsoleThumbnailService } from './console/thumbnailService.js';
import { Poller } from './poller/poller.js';
import { createPveDispatcher, createPveWsAgent } from './pve/dispatcher.js';
import { buildPveClient } from './pve/client.js';

export interface BuildAppOptions {
  config?: Config;
  webDistDir?: string;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  // Resolve relative to this module, not the process cwd: works from apps/server/src (tsx),
  // apps/server/dist (built), and /app/apps/server/dist inside the Docker image.
  // `PROXION_WEB_DIST` overrides this when the web build lives somewhere else
  // (e.g. a `pnpm deploy`-based Docker image, where the server package is
  // copied out from under `apps/server`).
  const webDistDir =
    options.webDistDir ??
    config.PROXION_WEB_DIST ??
    path.resolve(import.meta.dirname, '../../web/dist');

  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'test' ? 'silent' : 'info',
    },
  });

  // --- Shared PVE transport (built once, never per-request -- see pve/dispatcher.ts) ---
  const pveDispatcher = createPveDispatcher(config);
  const pveWsAgent = createPveWsAgent(config);
  app.decorate('proxionConfig', config);
  app.decorate('pveDispatcher', pveDispatcher);
  app.decorate('pveWsAgent', pveWsAgent);
  app.decorate('sessionStore', new SessionStore());
  app.decorate('consoleTicketStore', new ConsoleTicketStore());
  app.decorate('consoleThumbnails', new ConsoleThumbnailService(config, pveWsAgent, app.log));
  app.decorate('prefsStore', await PrefsStore.create(config, app.log));

  const hasServiceToken = Boolean(config.PVE_TOKEN_ID && config.PVE_TOKEN_SECRET);
  const tokenClient = hasServiceToken
    ? buildPveClient(
        config,
        { type: 'token', tokenId: config.PVE_TOKEN_ID!, tokenSecret: config.PVE_TOKEN_SECRET! },
        pveDispatcher,
      )
    : undefined;
  app.decorate('proxionTokenClient', tokenClient);

  const poller = tokenClient ? new Poller(tokenClient, app.log) : undefined;
  app.decorate('proxionPoller', poller);

  app.addHook('onClose', async () => {
    poller?.stop();
    pveWsAgent?.destroy();
    if (pveDispatcher) await pveDispatcher.close();
  });

  // --- Plugins ---
  await app.register(fastifyCookie, { secret: config.SESSION_SECRET });
  await app.register(fastifyRateLimit, { global: false });
  await app.register(fastifyWebsocket);

  // --- Routes ---
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(pveProxyRoutes);
  await app.register(actionsRoutes);
  await app.register(pollerRoutes);
  await app.register(consoleRoutes);
  await app.register(consoleWsRoutes);
  await app.register(consoleThumbnailRoutes);
  await app.register(prefsRoutes);

  if (config.NODE_ENV === 'production') {
    await app.register(fastifyStatic, {
      root: webDistDir,
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const rawUrl = request.raw.url ?? request.url;
    const pathname = rawUrl.split('?')[0] ?? rawUrl;
    // Exact `/api`/`/ws`, or a `/api/...`/`/ws/...` prefix -- NOT a bare `startsWith`,
    // which would also (wrongly) match a client-side route like `/apiary` or `/ws-help`.
    const isApiOrWs =
      pathname === '/api' ||
      pathname === '/ws' ||
      pathname.startsWith('/api/') ||
      pathname.startsWith('/ws/');

    if (isApiOrWs) {
      reply.code(404).send({ ok: false, error: 'Not Found' });
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      reply.code(405).send({ ok: false, error: 'Method Not Allowed' });
      return;
    }

    if (pathname.startsWith('/assets/')) {
      reply.code(404).send({ ok: false, error: 'Not Found' });
      return;
    }

    if (config.NODE_ENV === 'production') {
      reply.sendFile('index.html');
      return;
    }

    reply.code(404).send({ ok: false, error: 'Not Found' });
  });

  if (poller) poller.start();

  return app;
}
