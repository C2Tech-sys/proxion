import 'fastify';
import type { Agent } from 'undici';
import type { PveClient } from '@proxion/pve-api';
import type * as https from 'node:https';
import type { Config } from './config.js';
import type { SessionStore } from './auth/sessionStore.js';
import type { Poller } from './poller/poller.js';
import type { ConsoleTicketStore } from './console/ticketStore.js';
import type { ConsoleThumbnailService } from './console/thumbnailService.js';
import type { PrefsStore } from './prefs/store.js';

declare module 'fastify' {
  interface FastifyInstance {
    proxionConfig: Config;
    sessionStore: SessionStore;
    /** Single shared undici dispatcher for every `PveHttp` -- see `pve/dispatcher.ts`. */
    pveDispatcher: Agent | undefined;
    /** Single shared `https.Agent` for upstream `ws` (VNC/term) clients. */
    pveWsAgent: https.Agent | undefined;
    /** Cached client for the service token identity ("token mode"), built once at boot. Only set when a service token is configured. */
    proxionTokenClient: PveClient | undefined;
    /** Only running when a service token is configured. */
    proxionPoller: Poller | undefined;
    consoleTicketStore: ConsoleTicketStore;
    consoleThumbnails: ConsoleThumbnailService;
    prefsStore: PrefsStore;
  }
}
