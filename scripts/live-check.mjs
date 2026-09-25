// Live check: runs every tool against real resources in your Azure tenant and prints a
// pass/fail table. Read-only, like the server itself. Results stay on this machine.
//
// Usage: az login && npm run live-check
// Environment: any BETTERAZUREMCP_* setting (for example BETTERAZUREMCP_SUBSCRIPTIONS to
// limit the check to one subscription).

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdir, writeFile } from 'node:fs/promises';

const client = new Client({ name: 'live-check', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ['dist/betterazuremcp.mjs'],
    env: { ...process.env, BETTERAZUREMCP_LOG_LEVEL: 'error' },
    stderr: 'ignore',
  }),
);

const results = [];

/** Calls a tool and records the outcome. Returns the parsed JSON data, or undefined. */
async function check(label, name, args) {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  const ms = Date.now() - started;
  const status = result.isError ? 'FAIL' : 'ok';
  results.push({
    tool: name,
    target: label,
    status,
    ms,
    message: text.split('\n')[0].slice(0, 200),
  });
  console.log(
    `${status.padEnd(5)} ${name.padEnd(28)} ${label.padEnd(16)} ${String(ms).padStart(6)} ms  ${text.split('\n')[0].slice(0, 90)}`,
  );
  if (result.isError) return undefined;
  try {
    return JSON.parse(text.split('\n\n').at(-1));
  } catch {
    return undefined;
  }
}

console.log('status tool                         target             time  summary');
const context = await check('tenant', 'azure_context', {});
if (context === undefined) {
  console.log(
    '\nSign-in failed; fix it first (see the message above, or run `betterazuremcp doctor`).',
  );
  await client.close();
  process.exit(1);
}

const inventory = await check('inventory', 'azure_resource_graph_query', {
  query: [
    'resources',
    "| where type in~ ('microsoft.web/sites', 'microsoft.app/containerapps', 'microsoft.containerservice/managedclusters', 'microsoft.insights/components', 'microsoft.operationalinsights/workspaces')",
    "| extend kind = iff(type =~ 'microsoft.web/sites' and kind contains 'functionapp', 'functionapp', tolower(type))",
    '| summarize id = take_any(id) by kind',
  ].join('\n'),
});
const byKind = Object.fromEntries((inventory?.rows ?? []).map((row) => [row.kind, row.id]));
const web = byKind['microsoft.web/sites'];
const functionApp = byKind.functionapp;
const containerApp = byKind['microsoft.app/containerapps'];
const cluster = byKind['microsoft.containerservice/managedclusters'];
const appInsights = byKind['microsoft.insights/components'];
const workspace = byKind['microsoft.operationalinsights/workspaces'];

const any = web ?? containerApp ?? cluster ?? appInsights ?? workspace ?? functionApp;
if (any) {
  await check('any', 'azure_find_resources', { name: any.split('/').at(-1), limit: 5 });
  await check('any', 'azure_get_resource', { resourceId: any });
  await check('any', 'azure_resource_health', { resourceId: any });
  await check('any', 'azure_recent_changes', { scope: any, hours: 168 });
  await check('any', 'azure_activity_log', { scope: any, hours: 168 });
  await check('any', 'azure_telemetry_locations', { resourceId: any });
  const metrics = await check('any', 'azure_metrics', { resourceId: any });
  const firstMetric = metrics?.metrics?.[0]?.name;
  if (firstMetric)
    await check('any', 'azure_metrics', { resourceId: any, metrics: [firstMetric], hours: 6 });
}

if (web) {
  await check('web app', 'azure_appservice_overview', { resourceId: web });
  await check('web app', 'azure_appservice_logs', { resourceId: web, source: 'app', lines: 20 });
  await check('web app', 'azure_appservice_logs', {
    resourceId: web,
    source: 'platform',
    lines: 20,
  });
  await check('web app', 'azure_diagnostics', { resourceId: web });
  await check('web app', 'azure_logs_query', { scope: web, query: 'search * | take 5', hours: 24 });
}
if (functionApp)
  await check('function app', 'azure_appservice_overview', { resourceId: functionApp });

if (containerApp) {
  await check('container app', 'azure_containerapp_overview', { resourceId: containerApp });
  await check('container app', 'azure_containerapp_logs', {
    resourceId: containerApp,
    hours: 24,
    limit: 20,
  });
  await check('container app', 'azure_containerapp_logs', {
    resourceId: containerApp,
    source: 'system',
    hours: 24,
    limit: 20,
  });
  await check('container app', 'azure_diagnostics', { resourceId: containerApp });
}

if (cluster) {
  await check('aks', 'azure_aks_overview', { clusterId: cluster });
  await check('aks', 'azure_aks_workloads', { clusterId: cluster });
  const pods = await check('aks', 'azure_aks_workloads', {
    clusterId: cluster,
    view: 'pods',
    limit: 5,
  });
  const pod = pods?.pods?.[0];
  if (pod) {
    await check('aks', 'azure_aks_pod_logs', {
      clusterId: cluster,
      namespace: pod.namespace,
      pod: pod.name,
      tailLines: 20,
    });
  }
}

if (appInsights) {
  const failures = await check('app insights', 'azure_appinsights_failures', {
    appInsightsId: appInsights,
    hours: 168,
  });
  const operationId =
    failures?.failedRequests?.[0]?.sampleOperationId ??
    failures?.exceptions?.[0]?.sampleOperationId;
  if (operationId) {
    await check('app insights', 'azure_appinsights_trace', {
      appInsightsId: appInsights,
      operationId,
    });
  }
}
if (workspace)
  await check('workspace', 'azure_logs_query', {
    scope: workspace,
    query: 'print now()',
    hours: 1,
  });

await client.close();

const failed = results.filter((r) => r.status !== 'ok');
const covered = new Set(results.map((r) => r.tool));
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed, ${covered.size} of 20 tools exercised.`,
);
console.log(
  'Some failures are expected: a missing role or an app without logs is reported, not a bug. Check each message.',
);
await mkdir('live-check-results', { recursive: true });
const file = `live-check-results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
await writeFile(file, JSON.stringify(results, null, 2));
console.log(`Details: ${file} (contains resource names; do not share it publicly).`);
