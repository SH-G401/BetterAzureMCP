// Soak test: drives the built server over stdio with thousands of tool calls and fails if its
// memory keeps growing. Covers the transport, dispatch, validation, credential and rendering
// paths. Calls fail fast at sign-in (no Azure access is needed or used).
//
// The server runs with its JavaScript heap capped at 64 MB. Without a cap, V8 grows the heap
// lazily and resident memory rises in steps even without a leak. With the cap, a real leak
// makes the server run out of memory and the test fails; a healthy server stays flat.
//
// Usage: npm run soak
// Environment:
//   SOAK_ITERATIONS        rounds of calls after warm-up (default 3000, 5 calls each)
//   SOAK_MAX_GROWTH_MB     allowed resident-memory growth after warm-up (default 25)

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { execFileSync } from 'node:child_process';

const ITERATIONS = Number(process.env.SOAK_ITERATIONS ?? '3000');
const MAX_GROWTH_MB = Number(process.env.SOAK_MAX_GROWTH_MB ?? '25');
const WARMUP = 300;

if (process.platform === 'win32') {
  console.log('Soak test skipped: it reads memory with `ps`, which Windows does not have.');
  process.exit(0);
}

const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !key.startsWith('AZURE_') && !key.startsWith('BETTERAZUREMCP_')) {
    env[key] = value;
  }
}
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--max-old-space-size=64', process.env.SOAK_SERVER ?? 'dist/betterazuremcp.mjs'],
  env: { ...env, BETTERAZUREMCP_CREDENTIAL: 'environment', BETTERAZUREMCP_LOG_LEVEL: 'error' },
  stderr: 'ignore',
});
const client = new Client({ name: 'soak', version: '1.0.0' });
await client.connect(transport);
const pid = transport.pid;

function rssMb() {
  const kb = Number(
    execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim(),
  );
  return kb / 1024;
}

const SUB = '/subscriptions/00000000-0000-0000-0000-000000000001';
async function round(i) {
  await client.listTools();
  await client.callTool({ name: 'azure_context', arguments: {} });
  await client.callTool({
    name: 'azure_find_resources',
    arguments: { name: `app-${i}`, limit: 5 },
  });
  await client.callTool({
    name: 'azure_get_resource',
    arguments: { resourceId: `${SUB}/../evil-${i}` },
  });
  await client.callTool({
    name: 'azure_logs_query',
    arguments: {
      scope: `${SUB}/resourceGroups/rg/providers/Microsoft.Web/sites/app-${i}`,
      query: 'AppRequests | take 1',
    },
  });
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function sample(count = 5) {
  const values = [];
  for (let i = 0; i < count; i++) {
    values.push(rssMb());
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return median(values);
}

const started = Date.now();
const checkpoints = [];
let baseline;
let final;
try {
  for (let i = 0; i < WARMUP; i++) await round(i);
  baseline = await sample();
  for (let i = 0; i < ITERATIONS; i++) {
    await round(WARMUP + i);
    if ((i + 1) % Math.max(1, Math.floor(ITERATIONS / 6)) === 0) checkpoints.push(rssMb());
  }
  final = await sample();
} catch (error) {
  console.error(
    `FAIL: the server stopped responding (${error.message}). A memory leak makes it run out of heap.`,
  );
  process.exit(1);
}
await client.close();

const calls = (WARMUP + ITERATIONS) * 5;
const growth = final - baseline;
console.log(`Calls: ${calls} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(
  `Resident memory: ${baseline.toFixed(1)} MB after warm-up, ${final.toFixed(1)} MB at the end (${growth >= 0 ? '+' : ''}${growth.toFixed(1)} MB)`,
);
console.log(`Checkpoints (MB): ${checkpoints.map((c) => c.toFixed(1)).join(', ')}`);

if (growth > MAX_GROWTH_MB) {
  console.error(`FAIL: memory grew by more than ${MAX_GROWTH_MB} MB.`);
  process.exit(1);
}
console.log('OK: memory stayed flat.');
