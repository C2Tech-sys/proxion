// Generates `src/generated/endpoints.ts`: a purely type-level table mapping
// `"<METHOD> <path>"` to `{ params; returns }`, derived from `schema/apidoc.json`.
//
// Usage: tsx scripts/generate.ts (requires `pnpm extract` to have run first)
//
// Determinism: object keys are emitted in sorted order and no timestamps or
// non-deterministic data are written, so re-running produces a byte-identical
// file when the input schema is unchanged.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.join(__dirname, '..', 'schema');
const apidocJsonPath = path.join(schemaDir, 'apidoc.json');
const generatedDir = path.join(__dirname, '..', 'src', 'generated');
const outFile = path.join(generatedDir, 'endpoints.ts');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

interface JsonSchema {
  type?: string;
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  optional?: number | boolean;
  [key: string]: unknown;
}

interface ApiEndpointInfo {
  parameters?: {
    additionalProperties?: number;
    properties?: Record<string, JsonSchema>;
  };
  returns?: JsonSchema;
}

interface ApiNode {
  path?: string;
  info?: Partial<Record<HttpMethod, ApiEndpointInfo>>;
  children?: ApiNode[];
}

interface FlatEndpoint {
  method: HttpMethod;
  path: string;
  info: ApiEndpointInfo;
}

/** Quote a property name as a valid (always-safe) TS object-type key. */
function quoteKey(key: string): string {
  return JSON.stringify(key);
}

/**
 * Extract `{name}` path parameter names, in the order they appear in the
 * path. PVE path params aren't always identifier-shaped (`{route-map-id}`,
 * `{pci-id-or-mapping}`), so this matches anything between braces, not just
 * `\w+` -- must stay in sync with the same regex in `src/http.ts`.
 */
function pathParamNames(pathTemplate: string): string[] {
  const names: string[] = [];
  const re = /\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pathTemplate)) !== null) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

/** Map a JSON-schema-ish node (PVE apidoc flavour) to a TS type expression. */
function schemaToType(schema: JsonSchema | undefined): string {
  if (!schema || typeof schema !== 'object') return 'unknown';

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((value) => JSON.stringify(String(value))).join(' | ');
  }

  switch (schema.type) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array': {
      const itemType = schema.items ? schemaToType(schema.items) : 'unknown';
      return `(${itemType})[]`;
    }
    case 'object':
      return objectTypeFromProperties(schema.properties);
    default:
      // No `type` at all, but shaped like an object (PVE sometimes omits it).
      if (schema.properties) return objectTypeFromProperties(schema.properties);
      return 'unknown';
  }
}

/** Build an inline TS object-type literal from a properties map. */
function objectTypeFromProperties(
  properties: Record<string, JsonSchema> | undefined,
  requiredKeys?: ReadonlySet<string>,
): string {
  if (!properties || Object.keys(properties).length === 0) {
    return 'Record<string, unknown>';
  }

  const keys = Object.keys(properties).sort();
  const members = keys.map((key) => {
    const propSchema = properties[key];
    const forceRequired = requiredKeys?.has(key) ?? false;
    const isOptional =
      !forceRequired && (propSchema?.optional === 1 || propSchema?.optional === true);
    return `${quoteKey(key)}${isOptional ? '?' : ''}: ${schemaToType(propSchema)};`;
  });
  return `{ ${members.join(' ')} }`;
}

/** Build the params object type for one endpoint. Path params are always required. */
function paramsTypeForEndpoint(pathTemplate: string, info: ApiEndpointInfo): string {
  const properties = info.parameters?.properties ?? {};
  const pathParams = new Set(pathParamNames(pathTemplate));

  if (Object.keys(properties).length === 0) {
    // `Record<string, never>` reads as "no params" (same as `{}`, but avoids
    // the generated file tripping `@typescript-eslint/no-empty-object-type`).
    if (pathParams.size === 0) return 'Record<string, never>';
    // Path params not declared in `parameters.properties` (shouldn't normally
    // happen in the PVE schema, but stay correct if it does): type them as string.
    const keys = [...pathParams].sort();
    return `{ ${keys.map((k) => `${quoteKey(k)}: string;`).join(' ')} }`;
  }

  return objectTypeFromProperties(properties, pathParams);
}

function extractSchemaTree(): ApiNode[] {
  const raw = readFileSync(apidocJsonPath, 'utf8');
  return JSON.parse(raw) as ApiNode[];
}

function flattenEndpoints(nodes: ApiNode[]): FlatEndpoint[] {
  const flat: FlatEndpoint[] = [];

  const walk = (node: ApiNode): void => {
    if (typeof node.path === 'string' && node.info) {
      for (const method of HTTP_METHODS) {
        const info = node.info[method];
        if (info) {
          flat.push({ method, path: node.path, info });
        }
      }
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child);
    }
  };

  for (const node of nodes) walk(node);
  return flat;
}

function generateSource(endpoints: FlatEndpoint[]): string {
  // Sort by the composite key for full, tree-shape-independent determinism.
  const sorted = [...endpoints].sort((a, b) => {
    const keyA = `${a.method} ${a.path}`;
    const keyB = `${b.method} ${b.path}`;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });

  const lines: string[] = [];
  lines.push('// GENERATED FILE - do not edit by hand.');
  lines.push(
    '// Regenerate with: pnpm --filter @proxion/pve-api extract && pnpm --filter @proxion/pve-api generate',
  );
  lines.push('//');
  lines.push('// A purely type-level table of the Proxmox VE API surface, keyed by');
  lines.push('// "<METHOD> <path>". Consumed by `src/client.ts` via conditional/template');
  lines.push('// literal types to derive per-path `params`/`returns` types.');
  lines.push('');
  lines.push('export interface EndpointsTable {');
  for (const endpoint of sorted) {
    const key = quoteKey(`${endpoint.method} ${endpoint.path}`);
    const paramsType = paramsTypeForEndpoint(endpoint.path, endpoint.info);
    const returnsType = schemaToType(endpoint.info.returns);
    lines.push(`  ${key}: { params: ${paramsType}; returns: ${returnsType} };`);
  }
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const tree = extractSchemaTree();
  const endpoints = flattenEndpoints(tree);
  const source = generateSource(endpoints);

  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(outFile, source, 'utf8');

  const byteLength = Buffer.byteLength(source, 'utf8');
  console.log(
    `Generated ${endpoints.length} endpoint entries -> ${path.relative(process.cwd(), outFile)} (${byteLength} bytes)`,
  );
}

main();
