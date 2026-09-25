import type { AzureServices } from './tools/types.js';
import { readTokenIdentity } from './auth/tokenClaims.js';
import { describeError } from './azure/errors.js';
import { queryResourceGraph } from './azure/resourceGraph.js';
import { ALLOWED_ENDPOINTS, ARM_SCOPE } from './http/endpoints.js';
import { currentContext, describeContext } from './state/currentContext.js';
import { VERSION } from './version.js';

interface Check {
  name: string;
  /** Checks that need Azure access are skipped once sign-in has failed. */
  needsAzure?: boolean;
  run(): Promise<string>;
}

const MIN_NODE_MAJOR = 22;

/**
 * `betterazuremcp doctor`: checks the local setup and prints a report with fixes.
 * Returns the process exit code.
 */
export async function runDoctor(
  services: AzureServices,
  write: (text: string) => void,
): Promise<number> {
  const signal = AbortSignal.timeout(60_000);
  const checks: Check[] = [
    {
      name: 'Node.js version',
      run: () => {
        const major = Number(process.versions.node.split('.')[0]);
        if (major < MIN_NODE_MAJOR) {
          return Promise.reject(
            new Error(
              `Node.js ${process.versions.node} is too old. Install Node.js ${MIN_NODE_MAJOR} or newer.`,
            ),
          );
        }
        return Promise.resolve(process.versions.node);
      },
    },
    {
      name: 'Azure sign-in',
      run: async () => {
        const token = await services.credentials.getAccessToken(ARM_SCOPE, signal);
        const identity = readTokenIdentity(token.token);
        const status = services.credentials.getStatus();
        const source = status.state === 'ok' ? status.source : 'unknown';
        return `${identity.principal ?? identity.objectId ?? 'unknown'} (tenant ${identity.tenantId ?? 'unknown'}) via ${source}`;
      },
    },
    {
      name: 'Subscriptions',
      needsAzure: true,
      run: async () => {
        const page = await services.arm.list<{ subscriptionId: string; state: string }>(
          { path: '/subscriptions', apiVersion: '2022-12-01', signal },
          500,
        );
        const scope = services.config.subscriptions;
        if (scope !== undefined) {
          const visible = page.items.filter((s) => scope.includes(s.subscriptionId.toLowerCase()));
          const missing = scope.filter(
            (id) => !visible.some((s) => s.subscriptionId.toLowerCase() === id),
          );
          if (missing.length > 0) {
            throw new Error(
              `BETTERAZUREMCP_SUBSCRIPTIONS lists subscriptions your account cannot see: ${missing.join(', ')}. Check the IDs and the tenant.`,
            );
          }
          return `${visible.length} configured in BETTERAZUREMCP_SUBSCRIPTIONS, all accessible`;
        }
        if (page.items.length === 0) {
          throw new Error(
            'Signed in, but no subscriptions are visible. Check the tenant (BETTERAZUREMCP_TENANT_ID) or ask for Reader access.',
          );
        }
        const enabled = page.items.filter((s) => s.state === 'Enabled').length;
        return `${page.items.length} accessible, ${enabled} enabled`;
      },
    },
    {
      name: 'Azure Resource Graph',
      needsAzure: true,
      run: async () => {
        const result = await queryResourceGraph(services.arm, {
          query: 'resources | summarize count()',
          top: 1,
          signal,
        });
        const row = result.rows[0];
        const count = row ? Object.values(row)[0] : undefined;
        return `reachable, ${typeof count === 'number' ? count : '?'} resources indexed`;
      },
    },
  ];

  const { config } = services;
  write(`betterazuremcp ${VERSION} doctor\n\n`);
  let failures = 0;
  for (const check of checks) {
    if (check.needsAzure && services.credentials.getStatus().state !== 'ok') {
      write(`  skip  ${check.name}: requires a working sign-in\n`);
      continue;
    }
    try {
      write(`  ok    ${check.name}: ${await check.run()}\n`);
    } catch (error) {
      failures++;
      const [first, ...rest] = describeError(error).split('\n');
      write(`  FAIL  ${check.name}: ${first ?? ''}\n`);
      for (const line of rest) write(`        ${line}\n`);
    }
  }

  write('\nSettings\n');
  write(`  credential       ${config.credential}\n`);
  write(`  tenant           ${config.tenantId ?? '(from login)'}\n`);
  write(`  timeout          ${config.timeoutMs / 1000} s\n`);
  write(`  max response     ${config.maxResponseBytes / 1024} KB\n`);
  write(`  secrets          ${config.showSecrets ? 'shown' : 'masked'}\n`);
  write(`  subscriptions    ${config.subscriptions?.join(', ') ?? '(all accessible)'}\n`);
  const remembered = currentContext(services);
  write(
    `  current context  ${!config.rememberContext ? 'not remembered (BETTERAZUREMCP_REMEMBER_CONTEXT=false)' : remembered ? describeContext(remembered) : '(none yet)'}\n`,
  );
  if (config.rememberContext && services.context.filePath) {
    write(`  context file     ${services.context.filePath}\n`);
  }
  write(`  allowed hosts    ${ALLOWED_ENDPOINTS.map((e) => e.hosts).join(', ')}\n`);
  write(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`);
  return failures === 0 ? 0 : 1;
}
