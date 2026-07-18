#!/usr/bin/env node
//
// Generate TypeScript types AND Connect service stubs from the
// project's .proto files. Single source of truth: <repo>/proto/*.proto.
// Adapted from armeria-kotlin-toolkit's codegen template (MIT — see
// NOTICE).
//
// Stack: @bufbuild/protoc-gen-es (>= 2.x) emits both messages and
// Connect service definitions in one pass. The runtime side uses
// @connectrpc/connect-web's createGrpcWebTransport, which talks
// application/grpc-web+proto to the ArmeriaAppServer directly (no
// proxy). Configure the transport with `credentials: 'include'` so
// HttpOnly auth cookies ride along.
//
// Wired into package.json as `precheck`, so `npm run check` can never
// compile against stale types. The output directory is gitignored —
// generated code is never committed, so there is nothing to drift.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');
// Conventional repo-root proto/ first, then /proto (Docker layout).
const protoRoot = [
  resolve(webRoot, '..', 'proto'),
  '/proto',
].find(p => existsSync(p));
const outDir = join(webRoot, 'src', 'proto-gen');

if (!protoRoot) {
  console.warn('proto codegen skipped: no proto/ sources found');
  process.exit(0);
}

// The .proto files the web app consumes, dependency-first.
const PROTO_FILES = ['info.proto'];

const protocBin = process.platform === 'win32'
  ? join(webRoot, 'node_modules', '.bin', 'protoc.cmd')
  : join(webRoot, 'node_modules', '.bin', 'protoc');
const esPlugin = process.platform === 'win32'
  ? join(webRoot, 'node_modules', '.bin', 'protoc-gen-es.cmd')
  : join(webRoot, 'node_modules', '.bin', 'protoc-gen-es');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const esOpts = [
  'target=ts',      // emit TypeScript, not JS
  'json_types=true' // Connect-compatible service definitions
];

const args = [
  `--plugin=protoc-gen-es=${esPlugin}`,
  `--es_out=${outDir}`,
  `--es_opt=${esOpts.join(',')}`,
  `--proto_path=${protoRoot}`,
  ...PROTO_FILES.map(f => join(protoRoot, f)),
];

console.log(`> protoc ${PROTO_FILES.join(' ')} → ${outDir}`);
execFileSync(protocBin, args, { stdio: 'inherit', shell: process.platform === 'win32' });
console.log('proto codegen complete.');
