import type { RequestInit } from 'undici';
import type { EndpointsTable } from './generated/endpoints.js';
import { PveHttp, type PveParams } from './http.js';

/**
 * True iff every property of `T` is optional, i.e. `{}` is a valid `T` (so the
 * whole `params` argument can be omitted). Uses `NonNullable<unknown>`
 * instead of the `{}` type literal to keep `@typescript-eslint/no-empty-object-type`
 * happy; it's the same "any non-nullish value" check `{} extends T` relies on.
 */
type CanOmit<T> = NonNullable<unknown> extends T ? true : false;

type PathsForMethod<Method extends string> = {
  [Key in keyof EndpointsTable & string]: Key extends `${Method} ${infer Path}` ? Path : never;
}[keyof EndpointsTable & string];

type ParamsFor<Method extends string, Path extends string> = `${Method} ${Path}` extends keyof EndpointsTable
  ? EndpointsTable[`${Method} ${Path}`]['params']
  : never;

type ReturnsFor<Method extends string, Path extends string> = `${Method} ${Path}` extends keyof EndpointsTable
  ? EndpointsTable[`${Method} ${Path}`]['returns']
  : never;

type GetPaths = PathsForMethod<'GET'>;
type PostPaths = PathsForMethod<'POST'>;
type PutPaths = PathsForMethod<'PUT'>;
type DeletePaths = PathsForMethod<'DELETE'>;

/** `[params, init?]` when params can be omitted entirely, else `[params, init?]` required. */
type CallArgs<P> = CanOmit<P> extends true ? [params?: P, init?: RequestInit] : [params: P, init?: RequestInit];

/**
 * Fully-typed Proxmox VE API client. Path and method determine the shape of
 * `params` (path + query/body parameters) and the resolved return type, via
 * the generated `EndpointsTable`. Use `raw()` to escape the type table for
 * endpoints or path shapes it doesn't (yet) know about.
 */
export class PveClient {
  constructor(private readonly http: PveHttp) {}

  get<Path extends GetPaths>(path: Path, ...args: CallArgs<ParamsFor<'GET', Path>>): Promise<ReturnsFor<'GET', Path>> {
    const [params, init] = args;
    return this.http.request('GET', path, (params ?? {}) as PveParams, init) as Promise<ReturnsFor<'GET', Path>>;
  }

  post<Path extends PostPaths>(
    path: Path,
    ...args: CallArgs<ParamsFor<'POST', Path>>
  ): Promise<ReturnsFor<'POST', Path>> {
    const [params, init] = args;
    return this.http.request('POST', path, (params ?? {}) as PveParams, init) as Promise<ReturnsFor<'POST', Path>>;
  }

  put<Path extends PutPaths>(path: Path, ...args: CallArgs<ParamsFor<'PUT', Path>>): Promise<ReturnsFor<'PUT', Path>> {
    const [params, init] = args;
    return this.http.request('PUT', path, (params ?? {}) as PveParams, init) as Promise<ReturnsFor<'PUT', Path>>;
  }

  delete<Path extends DeletePaths>(
    path: Path,
    ...args: CallArgs<ParamsFor<'DELETE', Path>>
  ): Promise<ReturnsFor<'DELETE', Path>> {
    const [params, init] = args;
    return this.http.request('DELETE', path, (params ?? {}) as PveParams, init) as Promise<
      ReturnsFor<'DELETE', Path>
    >;
  }

  /** Untyped escape hatch: any method, any path, any params. */
  raw(method: string, path: string, params?: PveParams, init?: RequestInit): Promise<unknown> {
    return this.http.request(method, path, params ?? {}, init);
  }
}
