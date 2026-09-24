import type { FastifyInstance } from 'fastify';
import { APP_NAME } from '../config.js';
import { version } from '../version.js';

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({
    ok: true,
    name: APP_NAME,
    version,
  }));
}
