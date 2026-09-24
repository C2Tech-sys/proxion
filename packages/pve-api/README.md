# @proxion/pve-api

A fully typed TypeScript client for the Proxmox VE REST API, generated from
the vendored PVE API schema, plus a runtime HTTP transport with API-token
auth and TLS certificate-fingerprint pinning.

## Layout

- `schema/apidoc.js` — vendored copy of Proxmox's `apidoc.js` (see
  `schema/SOURCE.md` for provenance). **Never edited by hand.**
- `schema/apidoc.json` / `schema/stats.json` — committed, pretty-printed
  extraction of the schema tree embedded in `apidoc.js`, and a small
  `{ paths, endpoints }` count summary. Produced by `pnpm extract`.
- `src/generated/endpoints.ts` — committed, type-only `EndpointsTable`
  mapping `"<METHOD> <path>"` to `{ params; returns }`, produced by
  `pnpm generate`. Regenerate it whenever `schema/apidoc.json` changes; never
  edit it by hand.
- `src/curated.ts` — hand-written types for shapes better expressed by hand
  than generated (discriminated unions, loose/likely-to-grow objects, etc).
- `src/http.ts` — `PveHttp`, the runtime transport (request building, auth,
  TLS, response unwrapping/errors).
- `src/tls.ts` — fingerprint normalisation/comparison and the undici `Agent`
  used for TLS pinning / insecure mode.
- `src/client.ts` — `PveClient`, the typed `get`/`post`/`put`/`delete`/`raw`
  wrapper around `PveHttp`.

## Refreshing the schema

1. Re-download `https://<your-pve-host>:8006/pve-docs/api-viewer/apidoc.js`
   (or grab the latest from a running PVE host / the Proxmox docs site) over
   `packages/pve-api/schema/apidoc.js`.
2. Update `schema/SOURCE.md` with the new source URL/date/size.
3. Run:
   ```sh
   pnpm --filter @proxion/pve-api extract   # apidoc.js -> apidoc.json + stats.json
   pnpm --filter @proxion/pve-api generate  # apidoc.json -> src/generated/endpoints.ts
   ```
4. Run `pnpm build`, `pnpm typecheck`, `pnpm lint` and `pnpm test` from the
   repo root, fix any fallout (PVE occasionally changes a param's shape),
   and commit the four changed files (`apidoc.js`, `apidoc.json`,
   `stats.json`, `endpoints.ts`).

Both scripts are deterministic: given the same `apidoc.js` / `apidoc.json`,
re-running produces byte-identical output (stable, sorted keys; no
timestamps), so a second run should show no `git diff`.

## Usage

```ts
import { PveHttp, PveClient } from '@proxion/pve-api';

const http = new PveHttp({
  baseUrl: 'https://pve.example.com:8006',
  credentials: {
    type: 'token',
    tokenId: 'root@pam!proxion', // "<user>@<realm>!<token-name>"
    tokenSecret: process.env.PVE_TOKEN_SECRET!,
  },
  // Optional TLS controls -- see "TLS" below.
  tls: { fingerprint: process.env.PVE_TLS_FINGERPRINT },
});

const client = new PveClient(http);

// Fully typed: no params needed, return type is inferred from the schema.
const version = await client.get('/version');
console.log(version.release);

// Path params are required and type-checked; typos and missing params fail
// to compile (see test/types.test-d.ts for the compile-time contract).
const status = await client.get('/nodes/{node}/qemu/{vmid}/status/current', {
  node: 'pve',
  vmid: 100,
});

// POST/PUT send the remaining (non-path) params as an urlencoded body.
await client.post('/nodes/{node}/qemu/{vmid}/status/start', { node: 'pve', vmid: 100 });

// Escape hatch for endpoints/paths not (yet) reflected in the schema.
const raw = await client.raw('GET', '/some/custom/path', { foo: 1 });
```

### Curated types

For response shapes that are easier to hand-maintain than to generate
(discriminated unions, "loose" objects PVE grows over time), import from
`src/curated.ts` (re-exported from the package root): `ClusterResource`
(+ `isNode`/`isQemu`/`isLxc` narrowing helpers), `ClusterTask`,
`VmStatusCurrent`, `LxcStatusCurrent`, `NodeStatus`, `RrdDataPoint` +
`Timeframe`, `AgentNetworkInterface`, `StorageContentItem`, and `QemuConfig`.

### Request semantics

- Path params (`{node}`, `{vmid}`, ...) are substituted into the URL and
  removed from the remaining params.
- Remaining params go to the **query string** for `GET`/`DELETE`, and to an
  `application/x-www-form-urlencoded` **body** for `POST`/`PUT`.
- `boolean` values serialise as `1`/`0` (PVE's convention).
- Array values serialise as a comma-joined list (PVE's `-list` convention),
  e.g. `tags: ['a', 'b']` becomes `tags=a,b`.
- Responses are unwrapped from PVE's `{ data: ... }` envelope.
- A non-2xx response throws `PveApiError { status, message, errors }`.

## Auth modes

`Credentials` (from `src/http.ts`) is a union:

```ts
type Credentials =
  | { type: 'token'; tokenId: string; tokenSecret: string }
  | { type: 'ticket'; ticket: string; csrfToken: string };
```

- **`token`** (implemented, recommended): sends
  `Authorization: PVEAPIToken=<tokenId>=<tokenSecret>`.
- **`ticket`**: sends `Cookie: PVEAuthCookie=<ticket>` and a
  `CSRFPreventionToken` header, for a server-side pass-through login flow
  (`POST /access/ticket`) to be layered on top later without changing this
  interface.

## TLS

```ts
new PveHttp({
  baseUrl: '...',
  credentials: { ... },
  tls: {
    // Pin to a certificate by its SHA-256 fingerprint (PVE's `AA:BB:...`
    // form from the node's SSL fingerprint, case-insensitive; colons
    // optional). Skips hostname/chain-of-trust checks in favour of this.
    fingerprint: 'AA:BB:CC:...',
    // Or: skip all certificate validation. Dangerous; prefer `fingerprint`.
    insecure: true,
  },
});
```

Fingerprint pinning is implemented as a custom undici connector
(`createFingerprintConnector`, used by `createTlsAgent`) that completes the
TCP+TLS handshake with `rejectUnauthorized: false`, then independently
compares the SHA-256 of the peer certificate's DER bytes (`cert.raw`) to the
normalised expected fingerprint, destroying the socket and rejecting with
`PveTlsError` on mismatch. This check runs regardless of whether Node's own
chain-of-trust verification passed -- deliberately so, since Proxmox's
default certificate is self-signed and never passes chain verification. (An
earlier version of this used a `checkServerIdentity` callback instead; Node
only invokes that callback once the chain already verified, so it never fired
for a self-signed cert and the pin was silently a no-op.)

For callers that can't use undici's dispatcher (e.g. a websocket bridge built
on `ws`, which drives its own `node:https`/`node:tls` connections),
`createPinnedHttpsAgent(fingerprint)` gives an `https.Agent` with the same
post-handshake pinning semantics, usable with `node:https`/`ws` directly.

See `src/tls.ts` and the end-to-end tests in `test/tls.test.ts` (a real local
HTTPS server with a generated self-signed certificate, exercising both
`PveHttp` and `createPinnedHttpsAgent`).

## Sharing a dispatcher across many `PveHttp` instances

Each `new PveHttp({ tls })` builds its own undici `Agent` (and thus its own
TCP connection pool). That's fine for one client, but a server holding many
`PveHttp` instances against the _same_ PVE host -- one per credential set,
say -- shouldn't open a separate connection pool per instance for identical
TLS settings. The rule of thumb: **one dispatcher per PVE host, one
`PveHttp` per credential set**, sharing that one dispatcher:

```ts
import { createTlsAgent, PveHttp } from '@proxion/pve-api';

// Build once per PVE host...
const dispatcher = createTlsAgent({ fingerprint: process.env.PVE_TLS_FINGERPRINT })!;

// ...share it across every PveHttp/credential set talking to that host.
const adminClient = new PveHttp({ baseUrl, credentials: adminToken, dispatcher });
const userClient = new PveHttp({ baseUrl, credentials: userToken, dispatcher });

// Later, close it once (not per PveHttp instance) when the host is torn down:
await dispatcher.close();
```

`tls` and `dispatcher` are mutually exclusive on `PveHttpOptions` --
`PveHttp` throws immediately if both are given. `PveHttp#close()` closes an
`Agent` the instance built itself from `tls`, but is a no-op for a
`dispatcher` passed in explicitly (it isn't this instance's to close, since
other `PveHttp`/`PveClient` instances may still be using it):

```ts
const solo = new PveHttp({ baseUrl, credentials, tls: { fingerprint } });
// ... use solo ...
await solo.close(); // closes the Agent createTlsAgent built for `solo`
```

## Testing

- `pnpm --filter @proxion/pve-api test` runs the unit suite (transport
  request-building against a mocked `fetch`, TLS fingerprint logic, and
  package-level smoke tests). No network access required.
- `test/types.test-d.ts` is a compile-time-only test (vitest
  `expectTypeOf` + `// @ts-expect-error`), evaluated by
  `pnpm --filter @proxion/pve-api typecheck` (its `tsconfig.json` includes
  `test/**`), not by `vitest run`.
- `test/live.test.ts` is an opt-in smoke test against a real Proxmox VE
  host. It skips cleanly unless `PVE_URL`, `PVE_TOKEN_ID` and
  `PVE_TOKEN_SECRET` are set (this repo ships no `.env`, so it's skipped by
  default):
  ```sh
  PVE_URL=https://pve.example.com:8006 \
  PVE_TOKEN_ID='root@pam!proxion' \
  PVE_TOKEN_SECRET='...' \
  PVE_TLS_INSECURE=1 \
  pnpm --filter @proxion/pve-api test -- live.test.ts
  ```
