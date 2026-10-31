/**
 * Runs the smoke checks against the built package in whatever runtime runs
 * this file: `node`, `bun` or `deno run --allow-read`. Build first.
 */
import * as sdk from '../../dist/index.js';
import { smoke } from './smoke.mjs';

const runtime =
  typeof globalThis.Deno !== 'undefined'
    ? `Deno ${globalThis.Deno.version.deno}`
    : typeof globalThis.Bun !== 'undefined'
      ? `Bun ${globalThis.Bun.version}`
      : `Node ${globalThis.process?.versions?.node}`;

const passed = await smoke(sdk);
console.log(`${runtime}: ${passed.length} smoke checks passed`);
for (const name of passed) console.log(`  ✓ ${name}`);
