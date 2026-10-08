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
  /** Same as `setVmPermissions`, but for a node-scoped path (`/access/permissions?path=/nodes/{node}`)
   * instead of a guest-scoped one -- used by `nodeActions.test.ts`. */
  setNodePermissions: (node: string, privs: Record<string, boolean>) => void;
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
  /** Every `GET .../{type}/{vmid}/config` request PVE has received, in order (type + vmid), so a
   * test can prove a request was refused before the config was ever read. */
  configGetCalls: Array<{ type: 'qemu' | 'lxc'; vmid: number }>;
  /** Makes the next matching `PUT .../{type}/{vmid}/config` call fail with the given status/message. */
  setConfigError: (
    type: 'qemu' | 'lxc',
    vmid: number,
    status: number,
    message: string,
    errors?: Record<string, string>,
  ) => void;
  /** Sets the config `GET .../{type}/{vmid}/config` returns (used by the hardware route's
   * `balloon <= memory` check against the guest's current memory). Defaults to `{}`. */
  setGuestConfig: (type: 'qemu' | 'lxc', vmid: number, config: Record<string, unknown>) => void;
  /** Sets the list `GET .../{type}/{vmid}/pending` returns for a guest. Defaults to `[]`. */
  setPending: (
    type: 'qemu' | 'lxc',
    vmid: number,
    rows: Array<{ key: string; value?: string; pending?: string; delete?: number }>,
  ) => void;
  /** Makes `GET .../{type}/{vmid}/pending` fail with the given status (T48). */
  setPendingError: (type: 'qemu' | 'lxc', vmid: number, status: number) => void;
  /** Every `PUT .../{type}/{vmid}/resize` request PVE has received, in order (type + parsed form
   * body). Used by `hardwareRoutes.test.ts` (T48). */
  resizeCalls: Array<{ type: 'qemu' | 'lxc'; vmid: number; body: Record<string, string> }>;
  /** Makes the next `PUT .../{type}/{vmid}/resize` call for `vmid` fail with the given
   * status/message/errors. */
  setResizeError: (
    type: 'qemu' | 'lxc',
    vmid: number,
    status: number,
    message: string,
    errors?: Record<string, string>,
  ) => void;
  /** Whether `PUT .../resize` returns a UPID (the default, like modern PVE) or `null`. */
  setResizeReturnsUpid: (returnsUpid: boolean) => void;
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
  /** Every migrate POST request PVE has received, in order (type + path + parsed form body). */
  migrateCalls: Array<{ type: 'qemu' | 'lxc'; path: string; body: Record<string, string> }>;
  /** Every migrate precheck GET request PVE has received, in order (type + full path, including
   * any `?target=` query string PVE itself saw -- or its absence). */
  migratePrecheckCalls: Array<{ type: 'qemu' | 'lxc'; path: string }>;
  /** Makes the next matching `POST .../{type}/{vmid}/migrate` call fail with the given
   * status/message. */
  setMigrateError: (type: 'qemu' | 'lxc', vmid: number, status: number, message: string) => void;
  /** Sets the `GET .../{type}/{vmid}/migrate` precheck response for a given (type, vmid) --
   * whatever raw PVE-shaped object is given here is returned verbatim as `{ data: ... }`. */
  setMigratePrecheck: (type: 'qemu' | 'lxc', vmid: number, data: unknown) => void;
  /** Every `POST .../nodes/{node}/status` request PVE has received, in order (node + parsed form
   * body). Used by `nodeActions.test.ts` to assert exactly what was sent. */
  nodeStatusCalls: Array<{ node: string; body: Record<string, string> }>;
  /** Makes the next matching `POST .../nodes/{node}/status` call fail with the given status/message. */
  setNodeStatusError: (node: string, status: number, message: string) => void;
  /** Sets exactly which privileges `/access/permissions?path=/storage/{storage}` reports --
   * additive next to `setVmPermissions`/`setNodePermissions`, same shape/rationale, used by
   * `storageActions.test.ts` (T32). No defaults: absent a call, a storage grants nothing. */
  setStoragePermissions: (storage: string, privs: Record<string, boolean>) => void;
  // --- T64 ---
  /** Sets exactly which privileges `/access/permissions?path=/` (the root ACL path) reports.
   * No defaults: absent a call, `/` grants nothing -- so a test opts in to `Sys.Modify`. */
  setRootPermissions: (privs: Record<string, boolean>) => void;
  /**
   * Holds back the *next* `GET /access/permissions` response until `release()` is called --
   * used by `storageActions.test.ts` (T37) to reopen the T35 permission-check race: the upload
   * route awaits `hasStoragePrivilege()` before wiring up its client-disconnect listeners, so a
   * disconnect that lands while that request is in flight is the exact window the route's
   * synchronous `req.raw.destroyed` guard exists to catch. `reached` resolves the instant this
   * fake actually receives that request (before it replies), so a test can deterministically
   * disconnect its client mid-check rather than guessing at a timing window. One-shot: only the
   * next matching request is held; every other request (and every later one) answers immediately,
   * same as today.
   */
  holdPermissions: () => { release: () => void; reached: Promise<void> };
  /** Every `POST .../storage/{storage}/upload` request PVE has received, in order: the resolved
   * path, the exact `content-type` header seen (boundary intact), the query string PVE itself saw
   * (`content`/`filename`, if this fake ever needs to assert them), the exact byte count of the
   * body PVE received -- read directly off the raw request stream, never buffered further, so a
   * large-body test doesn't defeat its own point by holding the whole body in memory a second time
   * here -- and the full incoming header map, lower-cased the same way Node's own HTTP parser
   * already lower-cases every header name, for asserting exactly which headers this server
   * forwards (and which it never does -- see `storageActions.test.ts`'s header-forwarding test) --
   * and `parts` (T35), the multipart field names (and, for the one part carrying a
   * `filename="..."` attribute, that filename) this fake found in the body's first ~8 KiB, in
   * wire order, same as real pveproxy's own multipart parser reads them. */
  uploadCalls: Array<{
    path: string;
    contentType: string | undefined;
    query: Record<string, string>;
    bytes: number;
    headers: Record<string, string | string[] | undefined>;
    parts: Array<{ name: string; filename?: string }>;
  }>;
  /** Makes the next `POST .../storage/{storage}/upload` call fail with the given status/message
   * (checked before the body is even read, mirroring a real early PVE-side rejection e.g. a bad
   * file extension). `errors` optionally simulates PVE's own per-field `errors` map (T34), e.g.
   * `{ filename: "value does not match the regex pattern" }`. */
  setUploadError: (storage: string, status: number, message: string, errors?: Record<string, string>) => void;
  /** Every `POST .../storage/{storage}/download-url` request PVE has received, in order (path +
   * parsed form body, PVE's own field names e.g. `checksum-algorithm`/`verify-certificates`). */
  downloadUrlCalls: Array<{ path: string; body: Record<string, string> }>;
  /** `errors` optionally simulates PVE's own per-field `errors` map (T34), same as `setUploadError`. */
  setDownloadUrlError: (storage: string, status: number, message: string, errors?: Record<string, string>) => void;
  /** Every `GET .../query-url-metadata` request PVE has received, in order (full path incl. query
   * string). */
  queryUrlMetadataCalls: Array<{ path: string }>;
  /** Sets the `GET /nodes/{node}/query-url-metadata` response for the next call(s). */
  setQueryUrlMetadata: (data: { filename?: string; size?: number; mimetype?: string }) => void;
  /** Every `DELETE .../storage/{storage}/content/{volume}` request PVE has received, in order
   * (storage + decoded volume id). */
  deleteContentCalls: Array<{ storage: string; volume: string }>;
  setDeleteContentError: (storage: string, volume: string, status: number, message: string) => void;
  /** Every `POST .../vzdump` request PVE has received, in order (parsed form body). Used by
   * `backupRoutes.test.ts` (T41) to assert exactly what the server sent PVE for a backup start. */
  vzdumpCalls: Array<{ body: Record<string, string> }>;
  /** Makes the next `POST .../vzdump` call fail with the given status/message/errors -- same shape
   * as `setUploadError`. */
  setVzdumpError: (status: number, message: string, errors?: Record<string, string>) => void;
  /** Every `POST .../{type}` create/restore request PVE has received, in order (type + parsed form
   * body). Used by `backupRoutes.test.ts` to assert the qemu (`archive`) vs lxc (`ostemplate` +
   * `restore`) restore param mapping. */
  createCalls: Array<{ type: 'qemu' | 'lxc'; body: Record<string, string> }>;
  /** Makes the next `POST .../{type}` create/restore call for `vmid` fail with the given
   * status/message/errors. */
  setCreateError: (type: 'qemu' | 'lxc', vmid: number, status: number, message: string, errors?: Record<string, string>) => void;
  /** Sets the value `GET /cluster/nextid` returns. Defaults to `100`. */
  setNextId: (vmid: number) => void;
  /** Marks `vmid` as an existing cluster guest (surfaced via `GET /cluster/resources?type=vm`,
   * used by the restore route's target-exists check), optionally `running`. Additive to
   * `setClusterResources` -- a test that already sets full cluster resources via that can just
   * include a `{ type: 'qemu'|'lxc', vmid, status }` row itself instead. */
  setExistingGuest: (vmid: number, status: 'running' | 'stopped') => void;
  /** Every `POST .../{type}/{vmid}/clone` request PVE has received, in order (type + parsed form
   * body). Used by `cloneRoutes.test.ts` (T42) to assert exactly what the server sent PVE. */
  cloneCalls: Array<{ type: 'qemu' | 'lxc'; body: Record<string, string> }>;
  /** Makes the next `POST .../{type}/{vmid}/clone` call for the given source `vmid` fail with the
   * given status/message/errors -- same shape as `setCreateError`. */
  setCloneError: (
    type: 'qemu' | 'lxc',
    vmid: number,
    status: number,
    message: string,
    errors?: Record<string, string>,
  ) => void;
  /** Every `DELETE /nodes/{node}/{type}/{vmid}` (guest destroy) request PVE has received, in
   * order (type + vmid + the query params PVE saw -- DELETE params travel as a query string, see
   * `snapshotCalls`). Used by `destroyRoutes.test.ts` (T47) to assert exactly what the server sent. */
  destroyCalls: Array<{ type: 'qemu' | 'lxc'; vmid: number; query: Record<string, string> }>;
  /** Makes the next `DELETE .../{type}/{vmid}` (guest destroy) call for the given `vmid` fail with
   * the given status/message/errors -- same shape as `setCloneError`. */
  setDestroyError: (
    type: 'qemu' | 'lxc',
    vmid: number,
    status: number,
    message: string,
    errors?: Record<string, string>,
  ) => void;
  // --- T54 cloud-init ---
  /** Every `PUT .../qemu/{vmid}/cloudinit` (regenerate the cloud-init image) request PVE has
   * received, in order. Used by `cloudInitRoutes.test.ts` (T54). */
  cloudInitRegenerateCalls: Array<{ vmid: number; body: Record<string, string> }>;
  /** Makes the next `PUT .../qemu/{vmid}/cloudinit` call for `vmid` fail with the given status/message. */
  setCloudInitRegenerateError: (vmid: number, status: number, message: string) => void;
  /** Sets the per-key list `GET .../qemu/{vmid}/cloudinit` returns. Defaults to `[]`. */
  setCloudInitRows: (
    vmid: number,
    rows: Array<{ key: string; value?: string; pending?: string; delete?: number }>,
  ) => void;
  /** Makes `GET .../qemu/{vmid}/cloudinit` fail with the given status. */
  setCloudInitReadError: (vmid: number, status: number) => void;
  // --- end T54 ---
  /** Every guest firewall write PVE has received (`POST`/`PUT` `.../{type}/{vmid}/firewall/rules[/{pos}]`,
   * `PUT .../firewall/options`, `DELETE .../firewall/rules/{pos}`), in order: method + path + the
   * parsed form body (POST/PUT) or query string (DELETE). Used by `firewallRoutes.test.ts` (T56). */
  firewallCalls: Array<{ method: 'POST' | 'PUT' | 'DELETE'; path: string; body: Record<string, string> }>;
  /** Makes every guest firewall write to `target` (`rules` = rule POST/PUT/DELETE, `options`) fail
   * with the given status/message/errors, until called again with `undefined`. */
  setFirewallError: (
    target: 'rules' | 'options',
    failure: { status: number; message: string; errors?: Record<string, string> } | undefined,
  ) => void;
  // --- T63 convert to template ---
  /** Every `POST /nodes/{node}/{type}/{vmid}/template` request PVE has received, in order: type +
   * vmid + the parsed form body. Used by `templateRoutes.test.ts` (T63). */
  templateCalls: Array<{ type: 'qemu' | 'lxc'; vmid: number; body: Record<string, string> }>;
  /** Makes the next `POST .../{type}/{vmid}/template` call for `vmid` fail with the given status/message. */
  setTemplateError: (type: 'qemu' | 'lxc', vmid: number, status: number, message: string) => void;
  // --- end T63 ---
  // --- T67 datacenter firewall ---
  /** Every datacenter firewall write PVE has received (`POST`/`PUT`/`DELETE` under `/cluster/firewall/`
   * rules, options, groups, aliases and ipset), in order: method + the raw request path (so an
   * encoded `%2F` in an ipset CIDR is visible) + the parsed form body (POST/PUT) or query string
   * (DELETE). Used by `clusterFirewallRoutes.test.ts` (T67). */
  clusterFirewallCalls: Array<{ method: 'POST' | 'PUT' | 'DELETE'; path: string; body: Record<string, string> }>;
  /** Makes every datacenter firewall write fail with the given status/message until called again
   * with `undefined`. */
  setClusterFirewallError: (failure: { status: number; message: string } | undefined) => void;
  // --- end T67 ---
  // --- T66 backup jobs ---
  /** Replaces the cluster's vzdump job list (`GET /cluster/backup`); rows are returned verbatim. */
  setBackupJobs: (jobs: Array<Record<string, unknown>>) => void;
  /** Every `POST /cluster/backup`, `PUT /cluster/backup/{id}` and `DELETE /cluster/backup/{id}` PVE
   * has received, in order: method + job id (empty for the POST) + the parsed form body. Used by
   * `backupJobRoutes.test.ts` (T66). */
  backupJobCalls: Array<{ method: 'POST' | 'PUT' | 'DELETE'; id: string; body: Record<string, string> }>;
  /** Makes every backup-job write fail with the given status/message until called with `undefined`. */
  setBackupJobError: (failure: { status: number; message: string; errors?: Record<string, string> } | undefined) => void;
  /** Sets the `GET /cluster/backup/{id}/included_volumes` response for a job. */
  setBackupJobIncludedVolumes: (id: string, data: unknown) => void;
  // --- end T66 ---
  // --- T68 access ---
  /** Every `/access/*` write PVE has received (users, groups, acl, password, tokens), in order:
   * method + path (as PVE saw it, percent-encoding intact) + the parsed form body (POST/PUT) or query
   * string (DELETE). Used by `accessRoutes.test.ts` (T68). */
  accessCalls: Array<{ method: 'POST' | 'PUT' | 'DELETE'; path: string; body: Record<string, string> }>;
  /** Makes every `/access/*` write fail with the given status/message/errors, until called again
   * with `undefined`. */
  setAccessError: (failure: { status: number; message: string; errors?: Record<string, string> } | undefined) => void;
  /** Sets exactly which privileges `/access/permissions?path=<path>` reports for an ACL path:
   * `/access...` and `/pool/...` paths grant nothing unless set; any other configured path
   * (e.g. `/storage`, `/pool`) is answered from this map, unconfigured ones fall through to the
   * existing permissions handler. Shared by the T68 and T70 tests. */
  setPathPermissions: (path: string, privs: Record<string, boolean>) => void;
  /** Every `path` queried on `GET /access/permissions` that fell under `/access` or `/pool/`, in order. */
  accessPermissionPaths: string[];
  /** The API token secret `POST /access/users/{userid}/token/{tokenid}` returns (once). */
  accessTokenSecret: string;
  // --- end T68 ---
  // --- T70 storage config + pools ---
  /** Every `POST /storage`, `PUT /storage/{id}` and `DELETE /storage/{id}` PVE has received, in
   * order: method + path + the parsed form body. Used by `storageConfigRoutes.test.ts` (T70). */
  storageConfigCalls: Array<{ method: 'POST' | 'PUT' | 'DELETE'; path: string; body: Record<string, string> }>;
  /** Sets the config `GET /storage/{id}` returns (it also feeds `GET /storage`); an unknown id is a 404. */
  setStorageConfig: (storage: string, config: Record<string, unknown>) => void;
  /** Makes every storage write fail with the given status/message/errors until called with `undefined`. */
  setStorageConfigError: (failure: { status: number; message: string; errors?: Record<string, string> } | undefined) => void;
  /** Every `POST /pools`, `PUT /pools/{id}` and `DELETE /pools/{id}` PVE has received, in order. */
  poolCalls: Array<{ method: 'POST' | 'PUT' | 'DELETE'; path: string; body: Record<string, string> }>;
  /** Makes every pool write fail with the given status/message/errors until called with `undefined`. */
  setPoolError: (failure: { status: number; message: string; errors?: Record<string, string> } | undefined) => void;
  /** Sets the rows `GET /pools` returns. */
  setPools: (pools: unknown[]) => void;
  /** Sets the rows `GET /nodes/{node}/scan/<kind>` returns. */
  setScanResult: (kind: 'nfs' | 'cifs' | 'zfs' | 'lvm' | 'lvmthin', rows: unknown[]) => void;
  /** Every `GET /nodes/{node}/scan/<kind>` PVE has received (kind + the query string it saw). */
  scanCalls: Array<{ kind: string; query: Record<string, string> }>;
  // --- end T70 ---
  // --- T69 node network ---
  /** Every node network write PVE has received (`POST`/`PUT`/`DELETE` `/nodes/{node}/network[/{iface}]`),
   * in order: method + path + the parsed form body (POST/PUT) or query string (DELETE). Used by
   * `nodeNetworkRoutes.test.ts` (T69). */
  networkCalls: Array<{ method: 'POST' | 'PUT' | 'DELETE'; path: string; body: Record<string, string> }>;
  /** Sets the rows `GET /nodes/{node}/network` returns for `node` (default: a small pve1-like set). */
  setNetworkInterfaces: (node: string, rows: Array<Record<string, unknown>>) => void;
  /** Sets the top-level `changes` diff string `GET /nodes/{node}/network` returns beside `data`. */
  setNetworkChanges: (node: string, changes: string) => void;
  /** Makes every node network write of `op` fail with the given status/message/errors until called
   * again with `undefined`. */
  setNetworkError: (
    op: 'create' | 'update' | 'delete' | 'apply' | 'revert',
    failure: { status: number; message: string; errors?: Record<string, string> } | undefined,
  ) => void;
  // --- end T69 ---
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
  // Guests registered via `setExistingGuest` (T41) -- merged onto whatever `setClusterResources`
  // set, so a test only cares about the one thing it's asserting (either the full resource list,
  // or just "does this vmid exist"), never both at once.
  const existingGuestsByVmid = new Map<number, { status: 'running' | 'stopped' }>();
  app.get('/api2/json/cluster/resources', async () => {
    const extra = Array.from(existingGuestsByVmid.entries()).map(([vmid, g]) => ({
      type: 'qemu',
      vmid,
      status: g.status,
    }));
    return { data: [...clusterResources, ...extra] };
  });
  app.get('/api2/json/cluster/tasks', async () => ({ data: [] }));

  // `GET /cluster/nextid` -- real PVE's JSON response carries this as a native JSON number (unlike
  // the form-encoded string values every write route above sees), used by the restore dialog's
  // "use next free ID" button (`backupRoutes.ts`, T41).
  let nextId = 100;
  app.get('/api2/json/cluster/nextid', async () => ({ data: nextId }));

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
  const extraPermsByNode = new Map<string, Record<string, boolean>>();
  const extraPermsByStorage = new Map<string, Record<string, boolean>>();
  let rootPerms: Record<string, boolean> = {}; // T64
  const statusByGuest = new Map<string, 'running' | 'stopped'>();

  // One-shot hold for the *next* `/access/permissions` request -- see `holdPermissions` above.
  let pendingPermissionsHold:
    | { releasePromise: Promise<void>; resolveReached: () => void }
    | undefined;

  app.get('/api2/json/access/permissions', async (req, reply) => {
    if (pendingPermissionsHold) {
      const hold = pendingPermissionsHold;
      pendingPermissionsHold = undefined;
      hold.resolveReached();
      await hold.releasePromise;
    }
    const query = req.query as { path?: string };
    const vmMatch = query.path?.match(/^\/vms\/(\d+)$/);
    const nodeMatch = query.path?.match(/^\/nodes\/(.+)$/);
    const storageMatch = query.path?.match(/^\/storage\/(.+)$/);
    const vmid = vmMatch ? Number(vmMatch[1]) : undefined;
    const node = nodeMatch ? nodeMatch[1] : undefined;
    const storage = storageMatch ? storageMatch[1] : undefined;
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
    // Root path (`/`, T64): no defaults at all, like the node/storage paths.
    if (query.path === '/') {
      const rootBase: Record<string, number> = {};
      for (const [priv, grant] of Object.entries(rootPerms)) {
        if (grant) rootBase[priv] = 1;
      }
      reply.send({ data: { '/': rootBase } });
      return;
    }
    // Storage-scoped path (`/storage/{storage}`): same "no defaults" convention as the node path
    // below -- absent a `setStoragePermissions` call, a storage grants nothing.
    if (storage !== undefined) {
      const storageOverrides = extraPermsByStorage.get(storage);
      const storageBase: Record<string, number> = {};
      if (storageOverrides) {
        for (const [priv, grant] of Object.entries(storageOverrides)) {
          if (grant) storageBase[priv] = 1;
        }
      }
      reply.send({ data: { [path]: storageBase } });
      return;
    }
    // Node-scoped path (`/nodes/{node}`): no defaults at all -- absent a `setNodePermissions`
    // call, a node grants nothing (unlike the vm path's `VM.Console`/`VM.Audit` defaults, which
    // exist for the console-thumbnail tests that predate node permissions entirely).
    if (node !== undefined) {
      const nodeOverrides = extraPermsByNode.get(node);
      const nodeBase: Record<string, number> = {};
      if (nodeOverrides) {
        for (const [priv, grant] of Object.entries(nodeOverrides)) {
          if (grant) nodeBase[priv] = 1;
        }
      }
      reply.send({ data: { [path]: nodeBase } });
      return;
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
  const configErrors = new Map<string, { status: number; message: string; errors?: Record<string, string> }>();
  const configGetCalls: Array<{ type: 'qemu' | 'lxc'; vmid: number }> = [];
  const guestConfigs = new Map<string, Record<string, unknown>>();
  const pendingRows = new Map<string, Array<{ key: string; value?: string; pending?: string; delete?: number }>>();
  const pendingErrors = new Map<string, number>();
  const resizeCalls: Array<{ type: 'qemu' | 'lxc'; vmid: number; body: Record<string, string> }> = [];
  const resizeErrors = new Map<string, { status: number; message: string; errors?: Record<string, string> }>();
  let resizeReturnsUpid = true;

  function configErrorKey(type: 'qemu' | 'lxc', vmid: number): string {
    return `${type}:${vmid}`;
  }

  function registerConfigRoute(type: 'qemu' | 'lxc') {
    app.put(`/api2/json/nodes/:node/${type}/:vmid/config`, async (req, reply) => {
      const { vmid } = req.params as { node: string; vmid: string };
      configCalls.push({ path: req.url, body: (req.body ?? {}) as Record<string, string> });
      const failure = configErrors.get(configErrorKey(type, Number(vmid)));
      if (failure) {
        reply
          .code(failure.status)
          .send({ data: null, message: failure.message, ...(failure.errors ? { errors: failure.errors } : {}) });
        return;
      }
      reply.send({ data: null });
    });
    // Current guest config (`GET .../config`), settable via `setGuestConfig` (T48).
    app.get(`/api2/json/nodes/:node/${type}/:vmid/config`, async (req, reply) => {
      const { vmid } = req.params as { node: string; vmid: string };
      configGetCalls.push({ type, vmid: Number(vmid) });
      reply.send({ data: guestConfigs.get(configErrorKey(type, Number(vmid))) ?? {} });
    });
    // Pending config changes (`GET .../pending`), settable via `setPending` (T48).
    app.get(`/api2/json/nodes/:node/${type}/:vmid/pending`, async (req, reply) => {
      const { vmid } = req.params as { node: string; vmid: string };
      const key = configErrorKey(type, Number(vmid));
      const failureStatus = pendingErrors.get(key);
      if (failureStatus !== undefined) {
        reply.code(failureStatus).send({ data: null, message: 'pending unavailable' });
        return;
      }
      reply.send({ data: pendingRows.get(key) ?? [] });
    });
    // Disk grow (`PUT .../resize`), recorded and answered with a fake UPID (T48).
    app.put(`/api2/json/nodes/:node/${type}/:vmid/resize`, async (req, reply) => {
      const { vmid } = req.params as { node: string; vmid: string };
      resizeCalls.push({ type, vmid: Number(vmid), body: (req.body ?? {}) as Record<string, string> });
      const failure = resizeErrors.get(configErrorKey(type, Number(vmid)));
      if (failure) {
        reply
          .code(failure.status)
          .send({ data: null, message: failure.message, ...(failure.errors ? { errors: failure.errors } : {}) });
        return;
      }
      reply.send({
        data: resizeReturnsUpid ? `UPID:fakepve:00000001:00000000:00000000:resize:${vmid}:root@pam:` : null,
      });
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

  // Guest migrate endpoints (`GET`/`POST .../{type}/{vmid}/migrate`), used by
  // `src/actions/migrateRoutes.ts`. The GET (precheck) returns whatever `setMigratePrecheck` set
  // for that (type, vmid), defaulting to an empty-but-valid shape; the POST records every call
  // (type + path + parsed form body) and returns a fake UPID on success, same pattern as the
  // power-action/config/snapshot routes above.
  const migrateCalls: Array<{ type: 'qemu' | 'lxc'; path: string; body: Record<string, string> }> = [];
  const migratePrecheckCalls: Array<{ type: 'qemu' | 'lxc'; path: string }> = [];
  const migrateErrors = new Map<string, { status: number; message: string }>();
  const migratePrechecks = new Map<string, unknown>();

  function migrateKey(type: 'qemu' | 'lxc', vmid: number): string {
    return `${type}:${vmid}`;
  }

  function defaultPrecheck(type: 'qemu' | 'lxc'): unknown {
    return type === 'qemu'
      ? { running: false, local_disks: [], local_resources: [] }
      : { running: false };
  }

  function registerMigrateRoutesForType(type: 'qemu' | 'lxc') {
    app.get(`/api2/json/nodes/:node/${type}/:vmid/migrate`, async (req, reply) => {
      const { vmid } = req.params as { node: string; vmid: string };
      migratePrecheckCalls.push({ type, path: req.url });
      const data = migratePrechecks.get(migrateKey(type, Number(vmid))) ?? defaultPrecheck(type);
      reply.send({ data });
    });
    app.post(`/api2/json/nodes/:node/${type}/:vmid/migrate`, async (req, reply) => {
      const { vmid } = req.params as { node: string; vmid: string };
      migrateCalls.push({ type, path: req.url, body: (req.body ?? {}) as Record<string, string> });
      const failure = migrateErrors.get(migrateKey(type, Number(vmid)));
      if (failure) {
        reply.code(failure.status).send({ data: null, message: failure.message });
        return;
      }
      reply.send({ data: `UPID:fakepve:00000001:00000000:00000000:${type === 'qemu' ? 'qmigrate' : 'vzmigrate'}:${vmid}:root@pam:` });
    });
  }
  registerMigrateRoutesForType('qemu');
  registerMigrateRoutesForType('lxc');

  // Node power-action endpoint (`POST /nodes/{node}/status`), used by `src/actions/nodeRoutes.ts`.
  // PVE returns nothing useful for this endpoint (no UPID); this records every call (node +
  // parsed form body) and replies with an empty `data` on success, same recording pattern as the
  // guest-action/config/snapshot/migrate routes above.
  const nodeStatusCalls: Array<{ node: string; body: Record<string, string> }> = [];
  const nodeStatusErrors = new Map<string, { status: number; message: string }>();

  app.post('/api2/json/nodes/:node/status', async (req, reply) => {
    const { node } = req.params as { node: string };
    nodeStatusCalls.push({ node, body: (req.body ?? {}) as Record<string, string> });
    const failure = nodeStatusErrors.get(node);
    if (failure) {
      reply.code(failure.status).send({ data: null, message: failure.message });
      return;
    }
    reply.send({ data: null });
  });

  // Storage upload (`POST /nodes/{node}/storage/{storage}/upload`), used by
  // `src/actions/storageRoutes.ts` (T32). Fastify has no multipart parser by default either, so
  // this fake registers the same "hand over the raw stream" content-type parser production does,
  // then reads the body only to count its bytes (never buffering it) -- proving the server forwarded
  // it byte-exact without this fake needing to actually parse multipart itself.
  app.addContentTypeParser('multipart/form-data', (_req, payload, done) => {
    done(null, payload);
  });

  const uploadCalls: Array<{
    path: string;
    contentType: string | undefined;
    query: Record<string, string>;
    bytes: number;
    headers: Record<string, string | string[] | undefined>;
    /** The multipart part names (and, for the one part carrying a `filename="..."` attribute,
     * that filename) this fake found in the body's first ~8 KiB -- in wire order, same as real
     * pveproxy itself parses them (T35). Present on every recorded call, including ones the
     * strict field-name check below let through. */
    parts: Array<{ name: string; filename?: string }>;
  }> = [];
  const uploadErrors = new Map<string, { status: number; message: string; errors?: Record<string, string> }>();

  // How much of the body's head this fake ever inspects to find the multipart part names -- real
  // field values (`content`, `checksum`, ...) are a few bytes each, so this comfortably covers
  // every part's headers without ever holding a large upload's actual file bytes here.
  const MULTIPART_HEAD_CAP = 8192;

  /** Every `Content-Disposition: form-data; name="..."[; filename="..."]` header this fake sees in
   * `head`, in order -- the same information real pveproxy's own multipart parser
   * (`PVE::APIServer::AnyEvent::file_upload_multipart`) reads off each part in turn. */
  function parseMultipartPartNames(head: Buffer): Array<{ name: string; filename?: string }> {
    const text = head.toString('latin1');
    const partRe = /Content-Disposition:\s*form-data;\s*name="([^"]*)"(?:;\s*filename="([^"]*)")?/g;
    const parts: Array<{ name: string; filename?: string }> = [];
    for (const match of text.matchAll(partRe)) {
      const name = match[1]!;
      const filename = match[2];
      parts.push(filename !== undefined ? { name, filename } : { name });
    }
    return parts;
  }

  app.post('/api2/json/nodes/:node/storage/:storage/upload', async (req, reply) => {
    const { storage } = req.params as { node: string; storage: string };
    const failure = uploadErrors.get(storage);
    if (failure) {
      reply
        .code(failure.status)
        .send({ data: null, message: failure.message, ...(failure.errors ? { errors: failure.errors } : {}) });
      return;
    }

    let bytes = 0;
    let head = Buffer.alloc(0);
    for await (const chunk of req.body as AsyncIterable<Buffer>) {
      bytes += (chunk as Buffer).length;
      if (head.length < MULTIPART_HEAD_CAP) {
        head = Buffer.concat([head, chunk as Buffer]).subarray(0, MULTIPART_HEAD_CAP);
      }
    }

    const parts = parseMultipartPartNames(head);
    // Real pveproxy (`file_upload_multipart`) requires the part carrying a `filename="..."`
    // attribute -- the actual file data -- to itself be named exactly `filename`, and dies
    // immediately, before reading any file data, for any other name (T35: this is the bug that
    // made every real upload 400 -- the browser sent that part named `file`). Mirrored here,
    // verbatim including pveproxy's own message text, so a test can prove the fix without a real
    // PVE host.
    const filePart = parts.find((part) => part.filename !== undefined);
    if (filePart && filePart.name !== 'filename') {
      reply.code(400).send({ data: null, message: `wrong field name '${filePart.name}' for file upload, expected 'filename'` });
      return;
    }

    uploadCalls.push({
      path: req.url,
      contentType: req.headers['content-type'],
      query: (req.query ?? {}) as Record<string, string>,
      bytes,
      // `{ ...req.headers }` -- a plain copy, since Fastify's own `req.headers` is a live object
      // reused across requests by the underlying Node HTTP server.
      headers: { ...req.headers },
      parts,
    });
    reply.send({ data: 'UPID:fakepve:00000001:00000000:00000000:imgcopy:0:root@pam:' });
  });

  // Storage download-url (`POST /nodes/{node}/storage/{storage}/download-url`).
  const downloadUrlCalls: Array<{ path: string; body: Record<string, string> }> = [];
  const downloadUrlErrors = new Map<string, { status: number; message: string; errors?: Record<string, string> }>();

  app.post('/api2/json/nodes/:node/storage/:storage/download-url', async (req, reply) => {
    const { storage } = req.params as { node: string; storage: string };
    downloadUrlCalls.push({ path: req.url, body: (req.body ?? {}) as Record<string, string> });
    const failure = downloadUrlErrors.get(storage);
    if (failure) {
      reply
        .code(failure.status)
        .send({ data: null, message: failure.message, ...(failure.errors ? { errors: failure.errors } : {}) });
      return;
    }
    reply.send({ data: 'UPID:fakepve:00000001:00000000:00000000:download:0:root@pam:' });
  });

  // Query URL metadata (`GET /nodes/{node}/query-url-metadata`) -- node-scoped, no storage.
  const queryUrlMetadataCalls: Array<{ path: string }> = [];
  let queryUrlMetadataResult: { filename?: string; size?: number; mimetype?: string } = {};

  app.get('/api2/json/nodes/:node/query-url-metadata', async (req, reply) => {
    queryUrlMetadataCalls.push({ path: req.url });
    reply.send({ data: queryUrlMetadataResult });
  });

  // Storage content delete (`DELETE /nodes/{node}/storage/{storage}/content/{volume}`).
  const deleteContentCalls: Array<{ storage: string; volume: string }> = [];
  const deleteContentErrors = new Map<string, { status: number; message: string }>();

  app.delete('/api2/json/nodes/:node/storage/:storage/content/:volume', async (req, reply) => {
    const { storage, volume } = req.params as { node: string; storage: string; volume: string };
    const decodedVolume = decodeURIComponent(volume);
    deleteContentCalls.push({ storage, volume: decodedVolume });
    const failure = deleteContentErrors.get(`${storage}:${decodedVolume}`);
    if (failure) {
      reply.code(failure.status).send({ data: null, message: failure.message });
      return;
    }
    reply.send({ data: 'UPID:fakepve:00000001:00000000:00000000:imgdel:0:root@pam:' });
  });

  // Guest backup start (`POST /nodes/{node}/vzdump`), used by `src/actions/backupRoutes.ts` (T41).
  // Records every call (parsed form body) and returns a fake UPID on success, same recording
  // pattern as the power-action/config/snapshot/migrate routes above. Not keyed by vmid -- every
  // test exercising a PVE-side vzdump failure only ever backs up one guest at a time.
  const vzdumpCalls: Array<{ body: Record<string, string> }> = [];
  let vzdumpError: { status: number; message: string; errors?: Record<string, string> } | undefined;

  app.post('/api2/json/nodes/:node/vzdump', async (req, reply) => {
    vzdumpCalls.push({ body: (req.body ?? {}) as Record<string, string> });
    if (vzdumpError) {
      const failure = vzdumpError;
      reply
        .code(failure.status)
        .send({ data: null, message: failure.message, ...(failure.errors ? { errors: failure.errors } : {}) });
      return;
    }
    reply.send({ data: 'UPID:fakepve:00000001:00000000:00000000:vzdump:0:root@pam:' });
  });

  // Guest create/restore (`POST /nodes/{node}/qemu`, `POST /nodes/{node}/lxc`), used by the
  // restore route in `src/actions/backupRoutes.ts` (T41). Records every call (type + parsed form
  // body) and returns a fake UPID on success, keyed errors by (type, vmid) same as
  // `actionErrors`/`configErrors` above.
  const createCalls: Array<{ type: 'qemu' | 'lxc'; body: Record<string, string> }> = [];
  const createErrors = new Map<string, { status: number; message: string; errors?: Record<string, string> }>();

  function createErrorKey(type: 'qemu' | 'lxc', vmid: number): string {
    return `${type}:${vmid}`;
  }

  function registerCreateRoute(type: 'qemu' | 'lxc') {
    app.post(`/api2/json/nodes/:node/${type}`, async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, string>;
      createCalls.push({ type, body });
      const failure = createErrors.get(createErrorKey(type, Number(body.vmid)));
      if (failure) {
        reply
          .code(failure.status)
          .send({ data: null, message: failure.message, ...(failure.errors ? { errors: failure.errors } : {}) });
        return;
      }
      reply.send({ data: `UPID:fakepve:00000001:00000000:00000000:${type === 'qemu' ? 'qmrestore' : 'vzrestore'}:${body.vmid}:root@pam:` });
    });
  }
  registerCreateRoute('qemu');
  registerCreateRoute('lxc');

  // Guest clone (`POST /nodes/{node}/qemu/{vmid}/clone`, `POST /nodes/{node}/lxc/{vmid}/clone`),
  // used by `src/actions/cloneRoutes.ts` (T42). Records every call (type + parsed form body) and
  // returns a fake UPID on success, keyed errors by (type, source vmid) same as `createErrors`.
  const cloneCalls: Array<{ type: 'qemu' | 'lxc'; body: Record<string, string> }> = [];
  const cloneErrors = new Map<string, { status: number; message: string; errors?: Record<string, string> }>();

  function cloneErrorKey(type: 'qemu' | 'lxc', vmid: number): string {
    return `${type}:${vmid}`;
  }

  function registerCloneRoute(type: 'qemu' | 'lxc') {
    app.post(`/api2/json/nodes/:node/${type}/:vmid/clone`, async (req, reply) => {
      const { vmid } = req.params as { node: string; vmid: string };
      const body = (req.body ?? {}) as Record<string, string>;
      cloneCalls.push({ type, body });
      const failure = cloneErrors.get(cloneErrorKey(type, Number(vmid)));
      if (failure) {
        reply
          .code(failure.status)
          .send({ data: null, message: failure.message, ...(failure.errors ? { errors: failure.errors } : {}) });
        return;
      }
      reply.send({
        data: `UPID:fakepve:00000001:00000000:00000000:${type === 'qemu' ? 'qmclone' : 'vzclone'}:${vmid}:root@pam:`,
      });
    });
  }
  registerCloneRoute('qemu');
  registerCloneRoute('lxc');

  // Guest destroy (`DELETE /nodes/{node}/qemu/{vmid}`, `DELETE /nodes/{node}/lxc/{vmid}`), used by
  // `src/actions/destroyRoutes.ts` (T47). Records every call (type + vmid + query) and returns a
  // fake UPID on success, keyed errors by (type, vmid) same as `cloneErrors`.
  const destroyCalls: Array<{ type: 'qemu' | 'lxc'; vmid: number; query: Record<string, string> }> = [];
  const destroyErrors = new Map<string, { status: number; message: string; errors?: Record<string, string> }>();

  function registerDestroyRoute(type: 'qemu' | 'lxc') {
    app.delete(`/api2/json/nodes/:node/${type}/:vmid`, async (req, reply) => {
      const { vmid } = req.params as { node: string; vmid: string };
      destroyCalls.push({ type, vmid: Number(vmid), query: (req.query ?? {}) as Record<string, string> });
      const failure = destroyErrors.get(`${type}:${Number(vmid)}`);
      if (failure) {
        reply
          .code(failure.status)
          .send({ data: null, message: failure.message, ...(failure.errors ? { errors: failure.errors } : {}) });
        return;
      }
      reply.send({
        data: `UPID:fakepve:00000001:00000000:00000000:${type === 'qemu' ? 'qmdestroy' : 'vzdestroy'}:${vmid}:root@pam:`,
      });
    });
  }
  registerDestroyRoute('qemu');
  registerDestroyRoute('lxc');

  // --- T54 cloud-init ---
  // `GET /nodes/{node}/qemu/{vmid}/cloudinit` (the per-key current/pending list) and
  // `PUT .../cloudinit` (regenerate the image), used by `src/actions/cloudInitRoutes.ts`.
  const cloudInitRegenerateCalls: Array<{ vmid: number; body: Record<string, string> }> = [];
  const cloudInitRegenerateErrors = new Map<number, { status: number; message: string }>();
  const cloudInitRows = new Map<number, Array<{ key: string; value?: string; pending?: string; delete?: number }>>();
  const cloudInitReadErrors = new Map<number, number>();

  app.get('/api2/json/nodes/:node/qemu/:vmid/cloudinit', async (req, reply) => {
    const { vmid } = req.params as { node: string; vmid: string };
    const failureStatus = cloudInitReadErrors.get(Number(vmid));
    if (failureStatus !== undefined) {
      reply.code(failureStatus).send({ data: null, message: 'cloudinit unavailable' });
      return;
    }
    reply.send({ data: cloudInitRows.get(Number(vmid)) ?? [] });
  });
  app.put('/api2/json/nodes/:node/qemu/:vmid/cloudinit', async (req, reply) => {
    const { vmid } = req.params as { node: string; vmid: string };
    cloudInitRegenerateCalls.push({ vmid: Number(vmid), body: (req.body ?? {}) as Record<string, string> });
    const failure = cloudInitRegenerateErrors.get(Number(vmid));
    if (failure) {
      reply.code(failure.status).send({ data: null, message: failure.message });
      return;
    }
    reply.send({ data: null });
  });
  // --- end T54 ---
  // --- T56 guest firewall ---
  // `POST /nodes/{node}/{type}/{vmid}/firewall/rules`, `PUT`/`DELETE .../firewall/rules/{pos}` and
  // `PUT .../firewall/options`, used by `src/actions/firewallRoutes.ts`. Records every call (method
  // + path + parsed form body, or the query string for DELETE) and replies with an empty `data` on
  // success, same recording pattern as the config/snapshot/migrate routes above.
  const firewallCalls: Array<{ method: 'POST' | 'PUT' | 'DELETE'; path: string; body: Record<string, string> }> = [];
  const firewallErrors = new Map<'rules' | 'options', { status: number; message: string; errors?: Record<string, string> }>();

  function registerFirewallRoutesForType(type: 'qemu' | 'lxc') {
    const record = (
      method: 'POST' | 'PUT' | 'DELETE',
      target: 'rules' | 'options',
      req: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
    ) => {
      const body = (method === 'DELETE' ? req.query : req.body) ?? {};
      firewallCalls.push({ method, path: req.url.split('?')[0]!, body: { ...(body as Record<string, string>) } });
      const failure = firewallErrors.get(target);
      if (failure) {
        reply
          .code(failure.status)
          .send({ data: null, message: failure.message, ...(failure.errors ? { errors: failure.errors } : {}) });
        return;
      }
      reply.send({ data: null });
    };
    app.post(`/api2/json/nodes/:node/${type}/:vmid/firewall/rules`, async (req, reply) => {
      record('POST', 'rules', req, reply);
    });
    app.put(`/api2/json/nodes/:node/${type}/:vmid/firewall/rules/:pos`, async (req, reply) => {
      record('PUT', 'rules', req, reply);
    });
    app.delete(`/api2/json/nodes/:node/${type}/:vmid/firewall/rules/:pos`, async (req, reply) => {
      record('DELETE', 'rules', req, reply);
    });
    app.put(`/api2/json/nodes/:node/${type}/:vmid/firewall/options`, async (req, reply) => {
      record('PUT', 'options', req, reply);
    });
  }
  registerFirewallRoutesForType('qemu');
  registerFirewallRoutesForType('lxc');
  // --- end T56 guest firewall ---

  // --- T63 convert to template ---
  // `POST /nodes/{node}/qemu/{vmid}/template` (returns a UPID) and `POST .../lxc/{vmid}/template`
  // (returns null), used by `src/actions/templateRoutes.ts`.
  const templateCalls: Array<{ type: 'qemu' | 'lxc'; vmid: number; body: Record<string, string> }> = [];
  const templateErrors = new Map<string, { status: number; message: string }>();
  for (const type of ['qemu', 'lxc'] as const) {
    app.post(`/api2/json/nodes/:node/${type}/:vmid/template`, async (req, reply) => {
      const { vmid } = req.params as { node: string; vmid: string };
      templateCalls.push({ type, vmid: Number(vmid), body: (req.body ?? {}) as Record<string, string> });
      const failure = templateErrors.get(`${type}:${Number(vmid)}`);
      if (failure) {
        reply.code(failure.status).send({ data: null, message: failure.message });
        return;
      }
      reply.send({ data: type === 'qemu' ? `UPID:fakepve:00000001:00000000:00000000:qmtemplate:${vmid}:root@pam:` : null });
    });
  }
  // --- end T63 ---

  // --- T67 datacenter firewall ---
  // Every `POST`/`PUT`/`DELETE` under `/cluster/firewall/{rules,options,groups,aliases,ipset}` that
  // `src/actions/clusterFirewallRoutes.ts` issues. Records each call (method + raw path + parsed form
  // body, or the query string for DELETE) and replies with an empty `data`, same recording pattern
  // as the guest firewall block above.
  const clusterFirewallCalls: Array<{ method: 'POST' | 'PUT' | 'DELETE'; path: string; body: Record<string, string> }> = [];
  let clusterFirewallFailure: { status: number; message: string } | undefined;
  const recordClusterFirewall = (
    method: 'POST' | 'PUT' | 'DELETE',
    req: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
  ) => {
    const body = (method === 'DELETE' ? req.query : req.body) ?? {};
    clusterFirewallCalls.push({ method, path: req.url.split('?')[0]!, body: { ...(body as Record<string, string>) } });
    if (clusterFirewallFailure) {
      reply.code(clusterFirewallFailure.status).send({ data: null, message: clusterFirewallFailure.message });
      return;
    }
    reply.send({ data: null });
  };
  for (const route of [
    '/cluster/firewall/rules',
    '/cluster/firewall/rules/:pos',
    '/cluster/firewall/groups',
    '/cluster/firewall/groups/:group',
    '/cluster/firewall/groups/:group/:pos',
    '/cluster/firewall/aliases',
    '/cluster/firewall/aliases/:name',
    '/cluster/firewall/ipset',
    '/cluster/firewall/ipset/:name',
    '/cluster/firewall/ipset/:name/:cidr',
    '/cluster/firewall/options',
  ]) {
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      app.route({
        method,
        url: `/api2/json${route}`,
        handler: async (req, reply) => {
          recordClusterFirewall(method, req, reply);
        },
      });
    }
  }
  // --- end T67 ---
  // --- T66 backup jobs ---
  // `GET/POST /cluster/backup`, `GET/PUT/DELETE /cluster/backup/{id}` and
  // `GET /cluster/backup/{id}/included_volumes`, used by `src/actions/backupJobRoutes.ts`. A create
  // answers `null` and generates the id itself, like real PVE. "Run now" reuses the vzdump recorder.
  let backupJobs: Array<Record<string, unknown>> = [];
  let backupJobSeq = 0;
  let backupJobError: { status: number; message: string; errors?: Record<string, string> } | undefined;
  const backupJobCalls: Array<{ method: 'POST' | 'PUT' | 'DELETE'; id: string; body: Record<string, string> }> = [];
  const backupJobVolumes = new Map<string, unknown>();
  const failBackupJobWrite = (reply: { code: (n: number) => { send: (b: unknown) => void } }): boolean => {
    if (!backupJobError) return false;
    const failure = backupJobError;
    reply
      .code(failure.status)
      .send({ data: null, message: failure.message, ...(failure.errors ? { errors: failure.errors } : {}) });
    return true;
  };
  app.get('/api2/json/cluster/backup', async () => ({ data: backupJobs }));
  app.get('/api2/json/cluster/backup/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = backupJobs.find((j) => j.id === id);
    if (!job) {
      reply.code(404).send({ data: null, message: `no such vzdump job ${id}` });
      return;
    }
    reply.send({ data: job });
  });
  app.get('/api2/json/cluster/backup/:id/included_volumes', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!backupJobs.some((j) => j.id === id)) {
      reply.code(404).send({ data: null, message: `no such vzdump job ${id}` });
      return;
    }
    reply.send({ data: backupJobVolumes.get(id) ?? { children: [] } });
  });
  app.post('/api2/json/cluster/backup', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    backupJobCalls.push({ method: 'POST', id: '', body });
    if (failBackupJobWrite(reply)) return;
    backupJobSeq += 1;
    backupJobs.push({ ...body, id: body.id ?? `backup-fake-${backupJobSeq}` });
    reply.send({ data: null });
  });
  app.put('/api2/json/cluster/backup/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, string>;
    backupJobCalls.push({ method: 'PUT', id, body });
    if (failBackupJobWrite(reply)) return;
    const job = backupJobs.find((j) => j.id === id);
    if (!job) {
      reply.code(500).send({ data: null, message: `no such vzdump job ${id}` });
      return;
    }
    const { delete: toDelete, ...rest } = body;
    for (const key of (toDelete ?? '').split(',').filter(Boolean)) delete job[key];
    Object.assign(job, rest);
    reply.send({ data: null });
  });
  app.delete('/api2/json/cluster/backup/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    backupJobCalls.push({ method: 'DELETE', id, body: {} });
    if (failBackupJobWrite(reply)) return;
    backupJobs = backupJobs.filter((j) => j.id !== id);
    reply.send({ data: null });
  });
  // --- end T66 ---
  // --- T68 access ---
  // `/access/users`, `/access/groups`, `/access/acl`, `/access/password` and the token endpoints,
  // used by `src/actions/accessRoutes.ts`; plus `/access/permissions` answers for `/access...` and
  // `/pool/...` paths (via a preHandler so the existing permissions handler stays untouched).
  const accessCalls: Array<{ method: 'POST' | 'PUT' | 'DELETE'; path: string; body: Record<string, string> }> = [];
  let accessError: { status: number; message: string; errors?: Record<string, string> } | undefined;
  const pathPerms = new Map<string, Record<string, boolean>>();
  const accessPermissionPaths: string[] = [];
  const ACCESS_TOKEN_SECRET = '5f1d7c1e-9a52-4c0e-8f0a-3b6f1a2d4e77';
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'GET' || req.url.split('?')[0] !== '/api2/json/access/permissions') return;
    const path = (req.query as { path?: string }).path ?? '';
    // Answer for the paths T68 owns (nothing granted unless set) and for any other path a test
    // configured via `setPathPermissions` (T70: `/storage`, `/pool`, `/pool/<id>`).
    if (!(path === '/access' || path.startsWith('/access/') || path.startsWith('/pool/') || pathPerms.has(path))) return;
    accessPermissionPaths.push(path);
    const granted: Record<string, number> = {};
    for (const [priv, grant] of Object.entries(pathPerms.get(path) ?? {})) {
      if (grant) granted[priv] = 1;
    }
    return reply.send({ data: { [path]: granted } });
  });
  const recordAccess = (
    method: 'POST' | 'PUT' | 'DELETE',
    req: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
  ): boolean => {
    const body = (method === 'DELETE' ? req.query : req.body) ?? {};
    accessCalls.push({ method, path: req.url.split('?')[0]!, body: { ...(body as Record<string, string>) } });
    if (accessError) {
      reply
        .code(accessError.status)
        .send({ data: null, message: accessError.message, ...(accessError.errors ? { errors: accessError.errors } : {}) });
      return false;
    }
    return true;
  };
  for (const [method, route] of [
    ['POST', '/api2/json/access/users'],
    ['PUT', '/api2/json/access/users/:userid'],
    ['DELETE', '/api2/json/access/users/:userid'],
    ['PUT', '/api2/json/access/password'],
    ['POST', '/api2/json/access/groups'],
    ['PUT', '/api2/json/access/groups/:groupid'],
    ['DELETE', '/api2/json/access/groups/:groupid'],
    ['PUT', '/api2/json/access/acl'],
    ['PUT', '/api2/json/access/users/:userid/token/:tokenid'],
    ['DELETE', '/api2/json/access/users/:userid/token/:tokenid'],
  ] as const) {
    app.route({
      method,
      url: route,
      handler: async (req, reply) => {
        if (recordAccess(method, req, reply)) reply.send({ data: null });
      },
    });
  }
  app.post('/api2/json/access/users/:userid/token/:tokenid', async (req, reply) => {
    if (!recordAccess('POST', req, reply)) return;
    const { userid, tokenid } = req.params as { userid: string; tokenid: string };
    const { privsep, comment, expire } = (req.body ?? {}) as Record<string, string | undefined>;
    reply.send({
      data: {
        'full-tokenid': `${userid}!${tokenid}`,
        info: { ...(comment !== undefined ? { comment } : {}), ...(expire !== undefined ? { expire: Number(expire) } : {}), privsep: privsep ?? '1' },
        value: ACCESS_TOKEN_SECRET,
      },
    });
  });
  // --- end T68 ---
  // --- T70 storage config + pools ---
  // `POST /storage`, `GET|PUT|DELETE /storage/{id}`, `POST /pools`, `GET /pools`,
  // `PUT|DELETE /pools/{id}` and `GET /nodes/{node}/scan/<kind>`, used by
  // `src/actions/storageConfigRoutes.ts` / `poolRoutes.ts`.
  type T70Failure = { status: number; message: string; errors?: Record<string, string> };
  // Path permissions for `/storage`, `/pool`, `/pool/<id>` are answered by the shared T68 hook above.
  const storageConfigCalls: Array<{ method: 'POST' | 'PUT' | 'DELETE'; path: string; body: Record<string, string> }> = [];
  const storageConfigs = new Map<string, Record<string, unknown>>();
  let storageConfigError: T70Failure | undefined;
  const poolCalls: Array<{ method: 'POST' | 'PUT' | 'DELETE'; path: string; body: Record<string, string> }> = [];
  let poolError: T70Failure | undefined;
  let poolRows: unknown[] = [];
  const scanResults = new Map<string, unknown[]>();
  const scanCalls: Array<{ kind: string; query: Record<string, string> }> = [];
  const sendT70 = (reply: import('fastify').FastifyReply, failure: T70Failure | undefined): boolean => {
    if (!failure) return false;
    reply
      .code(failure.status)
      .send({ data: null, message: failure.message, ...(failure.errors ? { errors: failure.errors } : {}) });
    return true;
  };
  app.get('/api2/json/storage', async () => ({ data: Array.from(storageConfigs.values()) }));
  app.get('/api2/json/storage/:storage', async (req, reply) => {
    const { storage } = req.params as { storage: string };
    const config = storageConfigs.get(storage);
    if (!config) {
      reply.code(404).send({ data: null, message: `storage '${storage}' does not exist` });
      return;
    }
    reply.send({ data: config });
  });
  app.post('/api2/json/storage', async (req, reply) => {
    storageConfigCalls.push({ method: 'POST', path: '/storage', body: { ...((req.body ?? {}) as Record<string, string>) } });
    if (sendT70(reply, storageConfigError)) return;
    reply.send({ data: { storage: (req.body as Record<string, string> | undefined)?.storage, type: (req.body as Record<string, string> | undefined)?.type } });
  });
  app.put('/api2/json/storage/:storage', async (req, reply) => {
    const { storage } = req.params as { storage: string };
    storageConfigCalls.push({ method: 'PUT', path: `/storage/${storage}`, body: { ...((req.body ?? {}) as Record<string, string>) } });
    if (sendT70(reply, storageConfigError)) return;
    reply.send({ data: { storage } });
  });
  app.delete('/api2/json/storage/:storage', async (req, reply) => {
    const { storage } = req.params as { storage: string };
    storageConfigCalls.push({ method: 'DELETE', path: `/storage/${storage}`, body: { ...((req.query ?? {}) as Record<string, string>) } });
    if (sendT70(reply, storageConfigError)) return;
    reply.send({ data: null });
  });
  app.get('/api2/json/pools', async () => ({ data: poolRows }));
  app.post('/api2/json/pools', async (req, reply) => {
    poolCalls.push({ method: 'POST', path: '/pools', body: { ...((req.body ?? {}) as Record<string, string>) } });
    if (sendT70(reply, poolError)) return;
    reply.send({ data: null });
  });
  app.put('/api2/json/pools/:poolid', async (req, reply) => {
    const { poolid } = req.params as { poolid: string };
    poolCalls.push({ method: 'PUT', path: `/pools/${poolid}`, body: { ...((req.body ?? {}) as Record<string, string>) } });
    if (sendT70(reply, poolError)) return;
    reply.send({ data: null });
  });
  app.delete('/api2/json/pools/:poolid', async (req, reply) => {
    const { poolid } = req.params as { poolid: string };
    poolCalls.push({ method: 'DELETE', path: `/pools/${poolid}`, body: { ...((req.query ?? {}) as Record<string, string>) } });
    if (sendT70(reply, poolError)) return;
    reply.send({ data: null });
  });
  for (const kind of ['nfs', 'cifs', 'zfs', 'lvm', 'lvmthin'] as const) {
    app.get(`/api2/json/nodes/:node/scan/${kind}`, async (req) => {
      scanCalls.push({ kind, query: { ...((req.query ?? {}) as Record<string, string>) } });
      return { data: scanResults.get(kind) ?? [] };
    });
  }
  // --- end T70 ---
  // --- T69 node network ---
  // `GET/POST/PUT/DELETE /nodes/{node}/network[/{iface}]`, used by `src/actions/nodeNetworkRoutes.ts`.
  // The list carries PVE's top-level `changes` string beside `data`. Writes are recorded, not applied.
  const networkCalls: Array<{ method: 'POST' | 'PUT' | 'DELETE'; path: string; body: Record<string, string> }> = [];
  const networkRows = new Map<string, Array<Record<string, unknown>>>();
  const networkChanges = new Map<string, string>();
  const networkErrors = new Map<string, { status: number; message: string; errors?: Record<string, string> }>();
  const defaultNetworkRows: Array<Record<string, unknown>> = [
    { iface: 'eno1', type: 'eth', method: 'manual', active: 1, autostart: 1 },
    { iface: 'eno2', type: 'eth', method: 'manual', active: 1, autostart: 1 },
    {
      iface: 'vmbr0',
      type: 'bridge',
      method: 'static',
      active: 1,
      autostart: 1,
      address: '192.0.2.11',
      netmask: '255.255.255.0',
      cidr: '192.0.2.11/24',
      gateway: '192.0.2.1',
      bridge_ports: 'eno1',
      bridge_vlan_aware: 1,
    },
  ];
  function networkFail(op: string, reply: { code: (status: number) => { send: (body: unknown) => void } }): boolean {
    const failure = networkErrors.get(op);
    if (!failure) return false;
    reply
      .code(failure.status)
      .send({ data: null, message: failure.message, ...(failure.errors ? { errors: failure.errors } : {}) });
    return true;
  }
  app.get('/api2/json/nodes/:node/network', async (req) => {
    const { node } = req.params as { node: string };
    return { data: networkRows.get(node) ?? defaultNetworkRows, changes: networkChanges.get(node) ?? '' };
  });
  app.post('/api2/json/nodes/:node/network', async (req, reply) => {
    networkCalls.push({ method: 'POST', path: req.url, body: (req.body ?? {}) as Record<string, string> });
    if (networkFail('create', reply)) return;
    reply.send({ data: null });
  });
  app.put('/api2/json/nodes/:node/network', async (req, reply) => {
    networkCalls.push({ method: 'PUT', path: req.url, body: (req.body ?? {}) as Record<string, string> });
    if (networkFail('apply', reply)) return;
    reply.send({ data: 'UPID:fakepve:00000001:00000000:00000000:srvreload:networking:root@pam:' });
  });
  app.delete('/api2/json/nodes/:node/network', async (req, reply) => {
    networkCalls.push({ method: 'DELETE', path: req.url, body: (req.query ?? {}) as Record<string, string> });
    if (networkFail('revert', reply)) return;
    reply.send({ data: null });
  });
  app.put('/api2/json/nodes/:node/network/:iface', async (req, reply) => {
    networkCalls.push({ method: 'PUT', path: req.url, body: (req.body ?? {}) as Record<string, string> });
    if (networkFail('update', reply)) return;
    reply.send({ data: null });
  });
  app.delete('/api2/json/nodes/:node/network/:iface', async (req, reply) => {
    networkCalls.push({ method: 'DELETE', path: req.url, body: (req.query ?? {}) as Record<string, string> });
    if (networkFail('delete', reply)) return;
    reply.send({ data: null });
  });
  // --- end T69 ---
  // --- T72 vm firmware ---
  // `GET /nodes/{node}/capabilities/qemu/machines`: the machine types/versions the node offers
  // (the VM firmware route reuses the existing guest config PUT / GET / pending handlers).
  app.get('/api2/json/nodes/:node/capabilities/qemu/machines', async () => ({
    data: [
      { id: 'pc', type: 'i440fx', version: '9.0' },
      { id: 'pc-i440fx-9.0', type: 'i440fx', version: '9.0' },
      { id: 'pc-i440fx-8.1', type: 'i440fx', version: '8.1' },
      { id: 'q35', type: 'q35', version: '9.0' },
      { id: 'pc-q35-9.0', type: 'q35', version: '9.0' },
      { id: 'pc-q35-8.1', type: 'q35', version: '8.1' },
    ],
  }));
  // --- end T72 ---

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
    setNodePermissions: (node: string, privs: Record<string, boolean>) => {
      extraPermsByNode.set(node, privs);
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
    get configGetCalls() {
      return configGetCalls;
    },
    setConfigError: (
      type: 'qemu' | 'lxc',
      vmid: number,
      status: number,
      message: string,
      errors?: Record<string, string>,
    ) => {
      configErrors.set(configErrorKey(type, vmid), { status, message, ...(errors ? { errors } : {}) });
    },
    setGuestConfig: (type: 'qemu' | 'lxc', vmid: number, config: Record<string, unknown>) => {
      guestConfigs.set(configErrorKey(type, vmid), config);
    },
    setPending: (
      type: 'qemu' | 'lxc',
      vmid: number,
      rows: Array<{ key: string; value?: string; pending?: string; delete?: number }>,
    ) => {
      pendingRows.set(configErrorKey(type, vmid), rows);
    },
    setPendingError: (type: 'qemu' | 'lxc', vmid: number, status: number) => {
      pendingErrors.set(configErrorKey(type, vmid), status);
    },
    get resizeCalls() {
      return resizeCalls;
    },
    setResizeError: (
      type: 'qemu' | 'lxc',
      vmid: number,
      status: number,
      message: string,
      errors?: Record<string, string>,
    ) => {
      resizeErrors.set(configErrorKey(type, vmid), { status, message, ...(errors ? { errors } : {}) });
    },
    setResizeReturnsUpid: (returnsUpid: boolean) => {
      resizeReturnsUpid = returnsUpid;
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
    get migrateCalls() {
      return migrateCalls;
    },
    get migratePrecheckCalls() {
      return migratePrecheckCalls;
    },
    setMigrateError: (type: 'qemu' | 'lxc', vmid: number, status: number, message: string) => {
      migrateErrors.set(migrateKey(type, vmid), { status, message });
    },
    setMigratePrecheck: (type: 'qemu' | 'lxc', vmid: number, data: unknown) => {
      migratePrechecks.set(migrateKey(type, vmid), data);
    },
    get nodeStatusCalls() {
      return nodeStatusCalls;
    },
    setNodeStatusError: (node: string, status: number, message: string) => {
      nodeStatusErrors.set(node, { status, message });
    },
    setStoragePermissions: (storage: string, privs: Record<string, boolean>) => {
      extraPermsByStorage.set(storage, privs);
    },
    setRootPermissions: (privs: Record<string, boolean>) => {
      rootPerms = privs;
    },
    holdPermissions: () => {
      let resolveReached!: () => void;
      const reached = new Promise<void>((resolve) => {
        resolveReached = resolve;
      });
      let releaseFn!: () => void;
      const releasePromise = new Promise<void>((resolve) => {
        releaseFn = resolve;
      });
      pendingPermissionsHold = { releasePromise, resolveReached };
      return { release: () => releaseFn(), reached };
    },
    get uploadCalls() {
      return uploadCalls;
    },
    setUploadError: (storage: string, status: number, message: string, errors?: Record<string, string>) => {
      uploadErrors.set(storage, { status, message, ...(errors ? { errors } : {}) });
    },
    get downloadUrlCalls() {
      return downloadUrlCalls;
    },
    setDownloadUrlError: (storage: string, status: number, message: string, errors?: Record<string, string>) => {
      downloadUrlErrors.set(storage, { status, message, ...(errors ? { errors } : {}) });
    },
    get queryUrlMetadataCalls() {
      return queryUrlMetadataCalls;
    },
    setQueryUrlMetadata: (data: { filename?: string; size?: number; mimetype?: string }) => {
      queryUrlMetadataResult = data;
    },
    get deleteContentCalls() {
      return deleteContentCalls;
    },
    setDeleteContentError: (storage: string, volume: string, status: number, message: string) => {
      deleteContentErrors.set(`${storage}:${volume}`, { status, message });
    },
    get vzdumpCalls() {
      return vzdumpCalls;
    },
    setVzdumpError: (status: number, message: string, errors?: Record<string, string>) => {
      vzdumpError = { status, message, ...(errors ? { errors } : {}) };
    },
    get createCalls() {
      return createCalls;
    },
    setCreateError: (
      type: 'qemu' | 'lxc',
      vmid: number,
      status: number,
      message: string,
      errors?: Record<string, string>,
    ) => {
      createErrors.set(createErrorKey(type, vmid), { status, message, ...(errors ? { errors } : {}) });
    },
    setNextId: (vmid: number) => {
      nextId = vmid;
    },
    setExistingGuest: (vmid: number, status: 'running' | 'stopped') => {
      existingGuestsByVmid.set(vmid, { status });
    },
    get cloneCalls() {
      return cloneCalls;
    },
    setCloneError: (
      type: 'qemu' | 'lxc',
      vmid: number,
      status: number,
      message: string,
      errors?: Record<string, string>,
    ) => {
      cloneErrors.set(cloneErrorKey(type, vmid), { status, message, ...(errors ? { errors } : {}) });
    },
    get destroyCalls() {
      return destroyCalls;
    },
    setDestroyError: (
      type: 'qemu' | 'lxc',
      vmid: number,
      status: number,
      message: string,
      errors?: Record<string, string>,
    ) => {
      destroyErrors.set(`${type}:${vmid}`, { status, message, ...(errors ? { errors } : {}) });
    },
    // --- T54 cloud-init ---
    get cloudInitRegenerateCalls() {
      return cloudInitRegenerateCalls;
    },
    setCloudInitRegenerateError: (vmid: number, status: number, message: string) => {
      cloudInitRegenerateErrors.set(vmid, { status, message });
    },
    setCloudInitRows: (
      vmid: number,
      rows: Array<{ key: string; value?: string; pending?: string; delete?: number }>,
    ) => {
      cloudInitRows.set(vmid, rows);
    },
    setCloudInitReadError: (vmid: number, status: number) => {
      cloudInitReadErrors.set(vmid, status);
    },
    // --- end T54 ---
    // --- T56 guest firewall ---
    get firewallCalls() {
      return firewallCalls;
    },
    setFirewallError: (
      target: 'rules' | 'options',
      failure: { status: number; message: string; errors?: Record<string, string> } | undefined,
    ) => {
      if (failure) firewallErrors.set(target, failure);
      else firewallErrors.delete(target);
    },
    // --- end T56 guest firewall ---
    // --- T63 convert to template ---
    get templateCalls() {
      return templateCalls;
    },
    setTemplateError: (type: 'qemu' | 'lxc', vmid: number, status: number, message: string) => {
      templateErrors.set(`${type}:${vmid}`, { status, message });
    },
    // --- end T63 ---
    // --- T67 datacenter firewall ---
    get clusterFirewallCalls() {
      return clusterFirewallCalls;
    },
    setClusterFirewallError: (failure: { status: number; message: string } | undefined) => {
      clusterFirewallFailure = failure;
    },
    // --- end T67 ---
    // --- T66 backup jobs ---
    setBackupJobs: (jobs: Array<Record<string, unknown>>) => {
      backupJobs = jobs.map((j) => ({ ...j }));
    },
    get backupJobCalls() {
      return backupJobCalls;
    },
    setBackupJobError: (failure: { status: number; message: string; errors?: Record<string, string> } | undefined) => {
      backupJobError = failure;
    },
    setBackupJobIncludedVolumes: (id: string, data: unknown) => {
      backupJobVolumes.set(id, data);
    },
    // --- end T66 ---
    // --- T68 access ---
    get accessCalls() {
      return accessCalls;
    },
    setAccessError: (failure: { status: number; message: string; errors?: Record<string, string> } | undefined) => {
      accessError = failure;
    },
    setPathPermissions: (path: string, privs: Record<string, boolean>) => {
      pathPerms.set(path, privs);
    },
    get accessPermissionPaths() {
      return accessPermissionPaths;
    },
    accessTokenSecret: ACCESS_TOKEN_SECRET,
    // --- end T68 ---
    // --- T70 storage config + pools ---
    get storageConfigCalls() {
      return storageConfigCalls;
    },
    setStorageConfig: (storage: string, config: Record<string, unknown>) => {
      storageConfigs.set(storage, config);
    },
    setStorageConfigError: (failure: T70Failure | undefined) => {
      storageConfigError = failure;
    },
    get poolCalls() {
      return poolCalls;
    },
    setPoolError: (failure: T70Failure | undefined) => {
      poolError = failure;
    },
    setPools: (pools: unknown[]) => {
      poolRows = pools;
    },
    setScanResult: (kind: 'nfs' | 'cifs' | 'zfs' | 'lvm' | 'lvmthin', rows: unknown[]) => {
      scanResults.set(kind, rows);
    },
    get scanCalls() {
      return scanCalls;
    },
    // --- end T70 ---
    // --- T69 node network ---
    get networkCalls() {
      return networkCalls;
    },
    setNetworkInterfaces: (node: string, rows: Array<Record<string, unknown>>) => {
      networkRows.set(node, rows);
    },
    setNetworkChanges: (node: string, changes: string) => {
      networkChanges.set(node, changes);
    },
    setNetworkError: (
      op: 'create' | 'update' | 'delete' | 'apply' | 'revert',
      failure: { status: number; message: string; errors?: Record<string, string> } | undefined,
    ) => {
      if (failure) networkErrors.set(op, failure);
      else networkErrors.delete(op);
    },
    // --- end T69 ---
    close: () => app.close(),
  };
}
