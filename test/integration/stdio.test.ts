import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../helpers.js';

const SERVER = 'dist/betterazuremcp.mjs';

/** A clean environment with no Azure credentials, so sign-in fails deterministically. */
function serverEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('AZURE_') && !key.startsWith('BETTERAZUREMCP_')) {
      env[key] = value;
    }
  }
  return {
    ...env,
    BETTERAZUREMCP_CREDENTIAL: 'environment',
    BETTERAZUREMCP_LOG_LEVEL: 'error',
    // Never read or write the developer's own remembered context.
    BETTERAZUREMCP_REMEMBER_CONTEXT: 'false',
  };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connect(mode: 'legacy' | { pin: '2026-07-28' }): Promise<Client> {
  const client = new Client(
    { name: 'integration-test', version: '1.0.0' },
    { versionNegotiation: { mode } },
  );
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: serverEnv(),
      stderr: 'ignore',
    }),
  );
  clients.push(client);
  return client;
}

describe.each([
  ['2025-era protocol', 'legacy' as const],
  ['2026-07-28 protocol', { pin: '2026-07-28' as const }],
])('stdio server (%s)', (_label, mode) => {
  it('lists the read-only tools', async () => {
    const client = await connect(mode);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });

  it('answers immediately with sign-in instructions when not signed in', async () => {
    const client = await connect(mode);
    const started = Date.now();
    const result = await client.callTool({ name: 'azure_context', arguments: {} });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('az login');
  });

  it('validates input before calling Azure', async () => {
    const client = await connect(mode);
    const result = await client.callTool({
      name: 'azure_get_resource',
      arguments: { resourceId: '/subscriptions/x/../../evil' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('not a valid Azure resource ID');
  });
});

describe('remembered context', () => {
  it('tells the model which subscription the user worked in last time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'betterazuremcp-'));
    writeFileSync(
      join(dir, 'context.json'),
      JSON.stringify({
        subscriptionId: 'aaaaaaaa-0000-0000-0000-000000000001',
        subscriptionName: 'Orders Production',
        tenantId: '11111111-1111-1111-1111-111111111111',
      }),
    );
    const client = new Client({ name: 'integration-test', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER],
        env: {
          ...serverEnv(),
          BETTERAZUREMCP_REMEMBER_CONTEXT: 'true',
          BETTERAZUREMCP_STATE_DIR: dir,
        },
        stderr: 'ignore',
      }),
    );
    clients.push(client);
    expect(client.getInstructions()).toContain('Current context: subscription "Orders Production"');
  });
});

describe('stdout', () => {
  it('carries nothing but JSON-RPC messages', async () => {
    const child = spawn(process.execPath, [SERVER], {
      env: serverEnv(),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));

    const send = (message: object): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'azure_context', arguments: {} },
    });

    while (!stdout.includes('"id":3')) {
      await once(child.stdout, 'data');
    }
    child.stdin.end();
    await once(child, 'exit');

    const lines = stdout.split('\n').filter((line) => line !== '');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    }
  });
});

describe('command line', () => {
  it('prints the version', async () => {
    const child = spawn(process.execPath, [SERVER, '--version']);
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
    const [code] = (await once(child, 'exit')) as [number];
    expect(code).toBe(0);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
