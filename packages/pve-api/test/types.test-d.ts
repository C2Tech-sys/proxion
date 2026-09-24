// Type-level tests for the generated `EndpointsTable` + `PveClient` typing.
//
// These are checked by `tsc --noEmit` (via the package's `typecheck` script,
// whose tsconfig includes `test/**`) rather than by running vitest: both
// `expectTypeOf(...).toEqualTypeOf<...>()` and `// @ts-expect-error` are
// compile-time-only assertions, so a plain type-check evaluates them without
// needing vitest's separate typecheck runner.
import { expectTypeOf } from 'vitest';
import { PveClient, PveHttp } from '../src/index.js';

const http = new PveHttp({
  baseUrl: 'https://pve.example.com:8006',
  credentials: { type: 'token', tokenId: 'root@pam!proxion', tokenSecret: 'secret' },
});
const client = new PveClient(http);

// `client.get("/version")` needs no params and returns the typed version object.
expectTypeOf(client.get('/version')).resolves.toEqualTypeOf<{
  console?: 'applet' | 'vv' | 'html5' | 'xtermjs';
  release: string;
  repoid: string;
  version: string;
}>();

// No params argument at all is fine when every param is optional/absent.
void client.get('/version');

// Required path params: compiles with both provided, `vmid` typed as number.
expectTypeOf(
  client.get('/nodes/{node}/qemu/{vmid}/status/current', { node: 'pve', vmid: 100 }),
).resolves.toMatchTypeOf<{
  status: string;
  vmid: number;
}>();

// Missing a required path param is a type error.
// @ts-expect-error - `vmid` is required for this path.
void client.get('/nodes/{node}/qemu/{vmid}/status/current', { node: 'pve' });

// Missing the whole params argument when params are required is a type error.
// @ts-expect-error - params are required for this path.
void client.get('/nodes/{node}/qemu/{vmid}/status/current');

// A misspelled path is a type error (not assignable to the known path union).
// @ts-expect-error - not a real endpoint path.
void client.get('/nodes/{node}/qemu/{vmid}/status/currentt', { node: 'pve', vmid: 100 });

// Passing a GET-only path to `post` is a type error (method/path pairs are checked together).
// @ts-expect-error - `/version` has no POST entry in the endpoints table.
void client.post('/version', {});

// `raw()` is untyped: any method/path/params compile, and the result is `unknown`.
expectTypeOf(
  client.raw('GET', '/whatever/custom', { anything: 1 }),
).resolves.toEqualTypeOf<unknown>();

// Hyphenated path params (e.g. `{route-map-id}`) are required, typed as
// string, and keyed by their literal (hyphenated) name -- not silently
// dropped/renamed because `\w+`-only path-param matching missed them.
void client.get('/cluster/sdn/route-maps/entries/{route-map-id}', { 'route-map-id': 'x' });

// Missing that hyphenated path param is a type error.
// @ts-expect-error - `route-map-id` is a required path param.
void client.get('/cluster/sdn/route-maps/entries/{route-map-id}');

// Omitting the whole params argument for a hyphenated-path-param endpoint is also a type error.
// @ts-expect-error - `route-map-id` is required, so params can't be omitted.
void client.get('/cluster/sdn/route-maps/entries/{route-map-id}', {});
