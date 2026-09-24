// Extracts the JSON API tree embedded in the vendored `schema/apidoc.js` file
// and writes it out as pretty-printed, deterministic JSON, alongside a small
// stats summary. See `schema/SOURCE.md` for provenance of the vendored file.
//
// Usage: tsx scripts/extract.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.join(__dirname, '..', 'schema');
const apidocJsPath = path.join(schemaDir, 'apidoc.js');
const apidocJsonPath = path.join(schemaDir, 'apidoc.json');
const statsJsonPath = path.join(schemaDir, 'stats.json');

interface ApiEndpointInfo {
  description?: string;
  method?: string;
  name?: string;
  parameters?: {
    additionalProperties?: number;
    properties?: Record<string, unknown>;
  };
  returns?: Record<string, unknown>;
  permissions?: unknown;
  allowtoken?: number;
  protected?: number;
  proxyto?: string;
}

interface ApiNode {
  path?: string;
  text?: string;
  leaf?: number;
  info?: Record<string, ApiEndpointInfo>;
  children?: ApiNode[];
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;

function extractSchemaArrayText(source: string): string {
  const startIdx = source.indexOf('[');
  if (startIdx === -1) {
    throw new Error('Could not find the opening `[` of the apiSchema array in apidoc.js');
  }

  const endMarker = '\nlet method2cmd';
  const endIdx = source.indexOf(endMarker);
  if (endIdx === -1) {
    throw new Error('Could not find the `let method2cmd` marker that follows the apiSchema array');
  }

  let jsonText = source.slice(startIdx, endIdx).trim();
  if (jsonText.endsWith(';')) {
    jsonText = jsonText.slice(0, -1);
  }
  return jsonText;
}

function countPathsAndEndpoints(nodes: ApiNode[]): { paths: number; endpoints: number } {
  let paths = 0;
  let endpoints = 0;

  const walk = (node: ApiNode): void => {
    if (typeof node.path === 'string') {
      paths += 1;
    }
    if (node.info) {
      for (const method of HTTP_METHODS) {
        if (node.info[method]) {
          endpoints += 1;
        }
      }
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        walk(child);
      }
    }
  };

  for (const node of nodes) {
    walk(node);
  }

  return { paths, endpoints };
}

function main(): void {
  const source = readFileSync(apidocJsPath, 'utf8');
  const jsonText = extractSchemaArrayText(source);
  const tree = JSON.parse(jsonText) as ApiNode[];

  const prettyJson = `${JSON.stringify(tree, null, 2)}\n`;
  writeFileSync(apidocJsonPath, prettyJson, 'utf8');

  const stats = countPathsAndEndpoints(tree);
  const statsJson = `${JSON.stringify(stats, null, 2)}\n`;
  writeFileSync(statsJsonPath, statsJson, 'utf8');

  console.log(
    `Extracted ${stats.paths} paths / ${stats.endpoints} endpoints -> ${path.relative(process.cwd(), apidocJsonPath)}`,
  );
}

main();
