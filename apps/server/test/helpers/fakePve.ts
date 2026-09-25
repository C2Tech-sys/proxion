import Fastify, { type FastifyInstance } from 'fastify';

export interface FakePve {
  app: FastifyInstance;
  url: string;
  ticketCalls: Array<{ username: string; password: string }>;
  vncproxyCalls: number;
  termproxyCalls: number;
  /** The `cookie` header PVE itself saw on the most recent request (for asserting we never forward the browser's own cookie). */
  lastCookieHeader: string | undefined;
  /** The raw request URL (path + query string) PVE itself saw on the most recent request. */
  lastRequestUrl: string | undefined;
  /** Total number of requests PVE has received (for asserting a blocked path never reached it at all). */
  requestCount: number;
  setClusterResources: (resources: unknown[]) => void;
  /** Sets the full task list `GET /nodes/{node}/tasks` filters/pages over for a given node. */
  setNodeTasks: (node: string, tasks: unknown[]) => void;
  /** Sets whether `/access/permissions?path=/vms/{vmid}` reports `VM.Console` for that vmid. Defaults to `true` for any vmid not explicitly set. */
  setVmConsolePermission: (vmid: number, allowed: boolean) => void;
  /**
   * Generic version of `setVmConsolePermission`: sets exactly which privileges
   * `/access/permissions?path=/vms/{vmid}` reports for a given vmid, layered on top of the
   * `VM.Console`/`VM.Audit` defaults `setVmConsolePermission` and the unset default control --
   * a privilege set `false` here is removed even if it would otherwise default to present.
   */
  setVmPermissions: (vmid: number, privs: Record<string, boolean>) => void;
  /** Sets the `status` field `status/current` reports for a given (type, vmid). Defaults to `running`. */
  setVmStatus: (type: 'qemu' | 'lxc', vmid: number, status: 'running' | 'stopped') => void;
  /** Every `POST .../status/{action}` request PVE has received, in order (path + parsed form body). */
  actionCalls: Array<{ path: string; body: Record<string, string> }>;
  /** Makes the next matching `POST .../status/{action}` call fail with the given status/message. */
  setActionError: (
    type: 'qemu' | 'lxc',
    vmid: number,
    action: string,
    status: number,
    message: string,
  ) => void;
  /** Every `PUT .../{type}/{vmid}/config` request PVE has received, in order (path + parsed form body). */
  configCalls: Array<{ path: string; body: Record<string, string> }>;
  /** Makes the next matching `PUT .../{type}/{vmid}/config` call fail with the given status/message. */
  setConfigError: (type: 'qemu' | 'lxc', vmid: number, status: number, message: string) => void;
  /** Every snapshot create/delete/rollback request PVE has received, in order (method + path +
   * parsed form body). Used by `actionsSnapshots.test.ts` to assert exactly what was sent. */
  snapshotCalls: Array<{ method: string; path: string; body: Record<string, string> }>;
  /** Makes the next matching snapshot create/delete/rollback call fail with the given
   * status/message. `op` distinguishes the three routes sharing one `(type, vmid, snapname)` key
   * space (a delete and a rollback of the same snapshot name are different failures). */
  setSnapshotError: (
    op: 'create' | 'delete' | 'rollback',
    type: 'qemu' | 'lxc',
    vmid: number,
    snapname: string,
    status: number,
    message: string,
  ) => void;
  close: () => Promise<void>;
}

export interface FakePveOptions {
  /** username -> accepted password (login *and* renewal both check against this). */
  users?: Record<string, string>;
}

/**
 * A tiny local Fastify server pretending to be Proxmox VE, for exercising
 * the login/renewal/proxy/console-start flows without a real cluster.
 */
export async function startFakePve(options: FakePveOptions = {}): Promise<FakePve> {
  const users = options.users ?? { 'root@pam': 'goodpass' };
  const app = Fastify({ logger: false });

  let lastCookieHeader: string | undefined;
  let lastRequestUrl: string | undefined;
  let requestCount = 0;
  app.addHook('onRequest', async (req) => {
    lastCookieHeader = req.headers.cookie;
    lastRequestUrl = req.url;
    requestCount += 1;
  });

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  const ticketCalls: Array<{ username: string; password: string }> = [];
  const issuedTickets = new Set<string>();
  let vncproxyCalls = 0;
  let termproxyCalls = 0;

  app.post('/api2/json/access/ticket', async (req, reply) => {
    const body = req.body as { username?: string; password?: string };
    const username = body.username ?? '';
    const password = body.password ?? '';
    ticketCalls.push({ username, password });

    // Accept either the configured password (fresh login) or a ticket this
    // server itself issued (renewal: PVE re-issues a ticket given the
    // current one as `password`).
    if (users[username] === password || issuedTickets.has(password)) {
      const ticket = `PVE:${username}:FAKETICKET-${issuedTickets.size}`;
      issuedTickets.add(ticket);
      reply.send({
        data: {
          ticket,
          CSRFPreventionToken: 'FAKECSRF',
          username,
          cap: { vms: { 'VM.Audit': 1 } },
        },
      });
      return;
    }

    reply.code(401).send({ data: null, message: 'authentication failure' });
  });

  app.get('/api2/json/version', async () => ({ data: { version: '9.0', release: '9.0' } }));

  let clusterResources: unknown[] = [];
  app.get('/api2/json/cluster/resources', async () => ({ data: clusterResources }));
  app.get('/api2/json/cluster/tasks', async () => ({ data: [] }));

  // `GET /nodes/{node}/tasks` -- per-node task history (used by the poller's vzdump-history
  // fetch, T23). Honours `typefilter`/`since`/`limit`; `source` is accepted but every task in
  // the fixture already has both a start and an end time or neither, so it's not filtered on.
  const nodeTasks = new Map<string, unknown[]>();
  app.get('/api2/json/nodes/:node/tasks', async (req, reply) => {
    const { node } = req.params as { node: string };
    const query = req.query as {
      typefilter?: string;
      since?: string;
      limit?: string;
    };
    let tasks = nodeTasks.get(node) ?? [];
    if (query.typefilter !== undefined) {
      tasks = tasks.filter((t) => (t as { type?: string }).type === query.typefilter);
    }
    if (query.since !== undefined) {
      const since = Number(query.since);
      tasks = tasks.filter((t) => (t as { starttime: number }).starttime >= since);
    }
    if (query.limit !== undefined) {
      tasks = tasks.slice(0, Number(query.limit));
    }
    reply.send({ data: tasks });
  });

  app.post('/api2/json/nodes/:node/qemu/:vmid/vncproxy', async (req, reply) => {
    vncproxyCalls += 1;
    reply.send({ data: { port: 5900, ticket: 'VNCTICKET', user: 'root@pam', cert: 'x', upid: 'UPID:1' } });
  });
  app.post('/api2/json/nodes/:node/lxc/:vmid/vncproxy', async (req, reply) => {
    vncproxyCalls += 1;
    reply.send({ data: { port: 5901, ticket: 'VNCTICKET', user: 'root@pam', cert: 'x', upid: 'UPID:2' } });
  });
  app.post('/api2/json/nodes/:node/termproxy', async (req, reply) => {
    termproxyCalls += 1;
    reply.send({ data: { port: 5000, ticket: 'TERMTICKET', user: 'root@pam', upid: 'UPID:3' } });
  });
  app.post('/api2/json/nodes/:node/qemu/:vmid/termproxy', async (req, reply) => {
    termproxyCalls += 1;
    reply.send({ data: { port: 5001, ticket: 'TERMTICKET', user: 'root@pam', upid: 'UPID:4' } });
  });
  app.post('/api2/json/nodes/:node/lxc/:vmid/termproxy', async (req, reply) => {
    termproxyCalls += 1;
    reply.send({ data: { port: 5002, ticket: 'TERMTICKET', user: 'root@pam', upid: 'UPID:5' } });
  });

  // Permission and status/current endpoints used by the console thumbnail
  // route -- default to "allowed" / "running" so most tests need no setup.
  const consolePermissionByVmid = new Map<number, boolean>();
  const extraPermsByVmid = new Map<number, Record<string, boolean>>();
  const statusByGuest = new Map<string, 'running' | 'stopped'>();

  app.get('/api2/json/access/permissions', async (req, reply) => {
    const query = req.query as { path?: string };
    const match = query.path?.match(/^\/vms\/(\d+)$/);
    const vmid = match ? Number(match[1]) : undefined;
    const allowed = vmid === undefined ? true : (consolePermissionByVmid.get(vmid) ?? true);
    // Real PVE nests the result under the requested path, e.g.
    // `{ "/vms/113": { "VM.Console": 1, ... } }` -- not a flat map.
    const path = query.path ?? '/';
    const base: Record<string, number> = allowed ? { 'VM.Console': 1, 'VM.Audit': 1 } : { 'VM.Audit': 1 };
    // Layer any privileges set via `setVmPermissions` on top -- `true` grants (1), `false`
    // removes the key entirely (PVE never reports a privilege it denies).
    const overrides = vmid === undefined ? undefined : extraPermsByVmid.get(vmid);
    if (overrides) {
      for (const [priv, grant] of Object.entries(overrides)) {
        if (grant) base[priv] = 1;
        else delete base[priv];
      }
    }
    reply.send({ data: { [path]: base } });
  });

  app.get('/api2/json/nodes/:node/qemu/:vmid/status/current', async (req, reply) => {
    const { vmid } = req.params as { vmid: string };
    const status = statusByGuest.get(`qemu:${vmid}`) ?? 'running';
    reply.send({ data: { status, vmid: Number(vmid) } });
  });
  app.get('/api2/json/nodes/:node/lxc/:vmid/status/current', async (req, reply) => {
    const { vmid } = req.params as { vmid: string };
    const status = statusByGuest.get(`lxc:${vmid}`) ?? 'running';
    reply.send({ data: { status, vmid: Number(vmid) } });
  });

  // Guest power-action endpoints (`POST /nodes/{node}/{type}/{vmid}/status/{action}`), used by
  // `src/actions/routes.ts`. Records every call (path + parsed urlencoded body) so tests can
  // assert exactly what the server sent PVE, and returns a fake UPID on success.
  const actionCalls: Array<{ path: string; body: Record<string, string> }> = [];
  const actionErrors = new Map<string, { status: number; message: string }>();

  function actionErrorKey(type: 'qemu' | 'lxc', vmid: number, action: string): string {
    return `${type}:${vmid}:${action}`;
  }

  function registerActionRoute(type: 'qemu' | 'lxc') {
    app.post(`/api2/json/nodes/:node/${type}/:vmid/status/:action`, async (req, reply) => {
      const { vmid, action } = req.params as { node: string; vmid: string; action: string };
      actionCalls.push({ path: req.url, body: (req.body ?? {}) as Record<string, string> });
      const failure = actionErrors.get(actionErrorKey(type, Number(vmid), action));
      if (failure) {
        reply.code(failure.status).send({ data: null, message: failure.message });
        return;
      }
      reply.send({ data: `UPID:fakepve:00000001:00000000:00000000:${action}:${vmid}:root@pam:` });
    });
  }
  registerActionRoute('qemu');
  registerActionRoute('lxc');

  // Guest config-update endpoint (`PUT /nodes/{node}/{type}/{vmid}/config`), used by the
  // rename/notes route (`src/actions/routes.ts`). Records every call (path + parsed urlencoded
  // body) so tests can assert exactly what the server sent PVE (e.g. `name=` vs `hostname=`).
  const configCalls: Array<{ path: string; body: Record<string, string> }> = [];
  const configErrors = new Map<string, { status: number; message: string }>();

  function configErrorKey(type: 'qemu' | 'lxc', vmid: number): string {
    return `${type}:${vmid}`;
  }

  function registerConfigRoute(type: 'qemu' | 'lxc') {
    app.put(`/api2/json/nodes/:node/${type}/:vmid/config`, async (req, reply) => {
      const { vmid } = req.params as { node: string; vmid: string };
      configCalls.push({ path: req.url, body: (req.body ?? {}) as Record<string, string> });
      const failure = configErrors.get(configErrorKey(type, Number(vmid)));
      if (failure) {
        reply.code(failure.status).send({ data: null, message: failure.message });
        return;
      }
      reply.send({ data: null });
    });
  }
  registerConfigRoute('qemu');
  registerConfigRoute('lxc');

  // Snapshot create (`POST .../snapshot`), delete (`DELETE .../snapshot/{snapname}`) and
  // rollback (`POST .../snapshot/{snapname}/rollback`), used by `src/actions/snapshotRoutes.ts`.
  // Records every call (method + path + parsed form body) and returns a fake UPID on success,
  // same pattern as the power-action/config routes above.
  const snapshotCalls: Array<{ method: string; path: string; body: Record<string, string> }> = [];
  const snapshotErrors = new Map<string, { status: number; message: string }>();

  function snapshotErrorKey(
    op: 'create' | 'delete' | 'rollback',
    type: 'qemu' | 'lxc',
    vmid: number,
    snapname: string,
  ): string {
    return `${op}:${type}:${vmid}:${snapname}`;
  }

  function registerSnapshotRoutesForType(type: 'qemu' | 'lxc') {
    app.post(`/api2/json/nodes/:node/${type}/:vmid/snapshot`, async (req, reply) => {
      const { vmid } = req.params as { node: string; vmid: string };
      const body = (req.body ?? {}) as Record<string, string>;
      snapshotCalls.push({ method: 'POST', path: req.url, body });
      const failure = snapshotErrors.get(snapshotErrorKey('create', type, Number(vmid), body.snapname ?? ''));
      if (failure) {
        reply.code(failure.status).send({ data: null, message: failure.message });
        return;
      }
      reply.send({ data: `UPID:fakepve:00000001:00000000:00000000:snapshot:${vmid}:root@pam:` });
    });
    app.delete(`/api2/json/nodes/:node/${type}/:vmid/snapshot/:snapname`, async (req, reply) => {
      const { vmid, snapname } = req.params as { node: string; vmid: string; snapname: string };
      // `client.delete()` sends any remaining params (e.g. `force`) as a query string, not a
      // form body -- DELETE isn't in `PveHttp`'s `METHODS_WITH_BODY` (see `packages/pve-api/src/http.ts`).
      snapshotCalls.push({ method: 'DELETE', path: req.url, body: (req.query ?? {}) as Record<string, string> });
      const failure = snapshotErrors.get(snapshotErrorKey('delete', type, Number(vmid), snapname));
      if (failure) {
        reply.code(failure.status).send({ data: null, message: failure.message });
        return;
      }
      reply.send({ data: `UPID:fakepve:00000001:00000000:00000000:delsnapshot:${vmid}:root@pam:` });
    });
    app.post(`/api2/json/nodes/:node/${type}/:vmid/snapshot/:snapname/rollback`, async (req, reply) => {
      const { vmid, snapname } = req.params as { node: string; vmid: string; snapname: string };
      snapshotCalls.push({ method: 'POST', path: req.url, body: (req.body ?? {}) as Record<string, string> });
      const failure = snapshotErrors.get(snapshotErrorKey('rollback', type, Number(vmid), snapname));
      if (failure) {
        reply.code(failure.status).send({ data: null, message: failure.message });
        return;
      }
      reply.send({ data: `UPID:fakepve:00000001:00000000:00000000:rollback:${vmid}:root@pam:` });
    });
  }
  registerSnapshotRoutesForType('qemu');
  registerSnapshotRoutesForType('lxc');

  const url = await app.listen({ port: 0, host: '127.0.0.1' });

  return {
    app,
    url,
    ticketCalls,
    get vncproxyCalls() {
      return vncproxyCalls;
    },
    get termproxyCalls() {
      return termproxyCalls;
    },
    get lastCookieHeader() {
      return lastCookieHeader;
    },
    get lastRequestUrl() {
      return lastRequestUrl;
    },
    get requestCount() {
      return requestCount;
    },
    setClusterResources: (resources: unknown[]) => {
      clusterResources = resources;
    },
    setNodeTasks: (node: string, tasks: unknown[]) => {
      nodeTasks.set(node, tasks);
    },
    setVmConsolePermission: (vmid: number, allowed: boolean) => {
      consolePermissionByVmid.set(vmid, allowed);
    },
    setVmPermissions: (vmid: number, privs: Record<string, boolean>) => {
      extraPermsByVmid.set(vmid, privs);
    },
    setVmStatus: (type: 'qemu' | 'lxc', vmid: number, status: 'running' | 'stopped') => {
      statusByGuest.set(`${type}:${vmid}`, status);
    },
    get actionCalls() {
      return actionCalls;
    },
    setActionError: (type: 'qemu' | 'lxc', vmid: number, action: string, status: number, message: string) => {
      actionErrors.set(actionErrorKey(type, vmid, action), { status, message });
    },
    get configCalls() {
      return configCalls;
    },
    setConfigError: (type: 'qemu' | 'lxc', vmid: number, status: number, message: string) => {
      configErrors.set(configErrorKey(type, vmid), { status, message });
    },
    get snapshotCalls() {
      return snapshotCalls;
    },
    setSnapshotError: (
      op: 'create' | 'delete' | 'rollback',
      type: 'qemu' | 'lxc',
      vmid: number,
      snapname: string,
      status: number,
      message: string,
    ) => {
      snapshotErrors.set(snapshotErrorKey(op, type, vmid, snapname), { status, message });
    },
    close: () => app.close(),
  };
}
