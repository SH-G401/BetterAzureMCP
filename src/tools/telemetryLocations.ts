import { z } from 'zod';
import { findLinkedAppInsights } from '../azure/appInsights.js';
import { AzureApiError } from '../azure/errors.js';
import { parseResourceId } from '../azure/resourceId.js';
import { kqlString, queryResourceGraph } from '../azure/resourceGraph.js';
import { compact, resourceIdSchema } from './common.js';
import { defineTool, type ToolContext } from './types.js';

interface DiagnosticSetting {
  name: string;
  properties?: {
    workspaceId?: string;
    storageAccountId?: string;
    eventHubAuthorizationRuleId?: string;
    eventHubName?: string;
    marketplacePartnerId?: string;
    logs?: { category?: string; categoryGroup?: string; enabled?: boolean }[];
    metrics?: { category?: string; enabled?: boolean }[];
  };
}

interface Destination {
  kind: 'log-analytics' | 'application-insights' | 'storage' | 'event-hub' | 'partner';
  resourceId: string;
  via: string;
  categories?: string[];
  queryWith?: string;
}

/** Tables to query for a resource type, so the model knows where to start. */
const TABLE_HINTS: Record<string, string> = {
  'microsoft.web/sites':
    'AppServiceHTTPLogs, AppServiceConsoleLogs, AppServiceAppLogs, AppServicePlatformLogs',
  'microsoft.app/managedenvironments': 'ContainerAppConsoleLogs, ContainerAppSystemLogs',
  'microsoft.containerservice/managedclusters':
    'ContainerLogV2, KubePodInventory, KubeEvents, KubeNodeInventory (Container Insights); AKSControlPlane, AKSAudit (diagnostic settings)',
  'microsoft.insights/components': 'AppRequests, AppExceptions, AppDependencies, AppTraces',
};

export const telemetryLocationsTool = defineTool({
  name: 'azure_telemetry_locations',
  title: 'Where does telemetry go?',
  description: [
    "Finds where a resource's logs and telemetry are stored: diagnostic settings (Log Analytics workspaces, storage accounts, Event Hubs, with the enabled log categories), linked Application Insights, Container Apps environment logging, and AKS Container Insights.",
    'Returns the resource IDs to use with azure_logs_query and azure_appinsights_failures, and which tables to query. Call this before querying logs for a resource you have not looked at yet.',
  ].join(' '),
  inputSchema: z.object({
    resourceId: resourceIdSchema(
      'Resource ID, for example an App Service, Container App or AKS cluster.',
    ),
  }),
  async run(input, ctx) {
    const resource = parseResourceId(input.resourceId);
    const type = resource.type.toLowerCase();
    const notes: string[] = [];

    const [diagnostics, linked, specific] = await Promise.all([
      diagnosticDestinations(ctx, resource.id, 'diagnostic setting').catch((error: unknown) => {
        notes.push(unsupportedNote(error, 'Diagnostic settings'));
        return [];
      }),
      findLinkedAppInsights(ctx.arm, resource.id, ctx.signal).catch(() => []),
      typeSpecificDestinations(ctx, resource.id, type, notes),
    ]);

    const destinations: Destination[] = [
      ...diagnostics,
      ...linked.map((c) => ({
        kind: 'application-insights' as const,
        resourceId: c.id,
        via: 'linked Application Insights (hidden-link tag)',
        queryWith: `azure_appinsights_failures / azure_logs_query with scope ${c.id}`,
      })),
      ...specific,
    ];

    const hint = TABLE_HINTS[type === 'microsoft.web/sites/slots' ? 'microsoft.web/sites' : type];
    const summary =
      destinations.length === 0
        ? `${resource.name} does not send logs anywhere that could be found. Platform metrics are still available through azure_metrics.`
        : `${resource.name} sends telemetry to ${destinations.length} destination(s): ${[...new Set(destinations.map((d) => d.kind))].join(', ')}. Platform metrics are available through azure_metrics.`;

    return {
      summary,
      data: compact({ destinations, tables: hint, notes }),
      listKey: 'destinations',
    };
  },
});

async function diagnosticDestinations(
  ctx: ToolContext,
  resourceId: string,
  label: string,
): Promise<Destination[]> {
  const page = await ctx.arm.list<DiagnosticSetting>(
    {
      path: `${resourceId}/providers/Microsoft.Insights/diagnosticSettings`,
      apiVersion: '2021-05-01-preview',
      signal: ctx.signal,
    },
    50,
  );

  return page.items.flatMap((setting) => {
    const p = setting.properties ?? {};
    const categories = [
      ...(p.logs ?? [])
        .filter((l) => l.enabled)
        .map((l) => l.category ?? `group:${l.categoryGroup ?? '?'}`),
      ...(p.metrics ?? []).filter((m) => m.enabled).map((m) => `metrics:${m.category ?? '?'}`),
    ];
    const via = `${label} "${setting.name}"`;
    const out: Destination[] = [];
    if (p.workspaceId) {
      out.push({
        kind: 'log-analytics',
        resourceId: p.workspaceId,
        via,
        categories,
        queryWith: `azure_logs_query with scope ${resourceId} (only this resource) or ${p.workspaceId} (whole workspace)`,
      });
    }
    if (p.storageAccountId)
      out.push({ kind: 'storage', resourceId: p.storageAccountId, via, categories });
    if (p.eventHubAuthorizationRuleId) {
      out.push({ kind: 'event-hub', resourceId: p.eventHubAuthorizationRuleId, via, categories });
    }
    if (p.marketplacePartnerId)
      out.push({ kind: 'partner', resourceId: p.marketplacePartnerId, via, categories });
    return out;
  });
}

async function typeSpecificDestinations(
  ctx: ToolContext,
  resourceId: string,
  type: string,
  notes: string[],
): Promise<Destination[]> {
  try {
    if (type === 'microsoft.insights/components') {
      const component = await ctx.arm.request<{ properties?: { WorkspaceResourceId?: string } }>({
        method: 'GET',
        path: resourceId,
        apiVersion: '2020-02-02',
        signal: ctx.signal,
      });
      const workspace = component.properties?.WorkspaceResourceId;
      return workspace
        ? [
            {
              kind: 'log-analytics',
              resourceId: workspace,
              via: 'workspace-based Application Insights',
              queryWith: `azure_logs_query with scope ${resourceId}`,
            },
          ]
        : [];
    }

    if (type === 'microsoft.app/containerapps') {
      const app = await ctx.arm.request<{
        properties?: { environmentId?: string; managedEnvironmentId?: string };
      }>({
        method: 'GET',
        path: resourceId,
        apiVersion: '2024-03-01',
        signal: ctx.signal,
      });
      const envId = app.properties?.environmentId ?? app.properties?.managedEnvironmentId;
      return envId ? await environmentDestinations(ctx, envId) : [];
    }

    if (type === 'microsoft.app/managedenvironments') {
      return await environmentDestinations(ctx, resourceId);
    }

    if (type === 'microsoft.containerservice/managedclusters') {
      const cluster = await ctx.arm.request<{
        properties?: {
          addonProfiles?: Record<string, { enabled?: boolean; config?: Record<string, string> }>;
          azureMonitorProfile?: { metrics?: { enabled?: boolean } };
        };
      }>({ method: 'GET', path: resourceId, apiVersion: '2024-05-01', signal: ctx.signal });
      const addons = cluster.properties?.addonProfiles ?? {};
      const oms = Object.entries(addons).find(([name]) => name.toLowerCase() === 'omsagent')?.[1];
      const workspace = oms?.enabled
        ? Object.entries(oms.config ?? {}).find(
            ([k]) => k.toLowerCase() === 'loganalyticsworkspaceresourceid',
          )?.[1]
        : undefined;
      if (cluster.properties?.azureMonitorProfile?.metrics?.enabled) {
        notes.push('Managed Prometheus metrics are enabled (Azure Monitor workspace).');
      }
      return workspace
        ? [
            {
              kind: 'log-analytics',
              resourceId: workspace,
              via: 'Container Insights',
              queryWith: `azure_logs_query with scope ${resourceId}`,
            },
          ]
        : [];
    }
  } catch (error) {
    notes.push(unsupportedNote(error, 'Resource details'));
  }
  return [];
}

async function environmentDestinations(ctx: ToolContext, envId: string): Promise<Destination[]> {
  const env = await ctx.arm.request<{
    properties?: {
      appLogsConfiguration?: {
        destination?: string;
        logAnalyticsConfiguration?: { customerId?: string };
      };
    };
  }>({ method: 'GET', path: envId, apiVersion: '2024-03-01', signal: ctx.signal });

  const config = env.properties?.appLogsConfiguration;
  if (config?.destination === 'log-analytics' && config.logAnalyticsConfiguration?.customerId) {
    const result = await queryResourceGraph(ctx.arm, {
      query: [
        'resources',
        "| where type =~ 'microsoft.operationalinsights/workspaces'",
        `| where tostring(properties.customerId) =~ ${kqlString(config.logAnalyticsConfiguration.customerId)}`,
        '| project id',
      ].join('\n'),
      top: 1,
      signal: ctx.signal,
    });
    const workspaceId = result.rows[0]?.id;
    return [
      {
        kind: 'log-analytics',
        resourceId:
          typeof workspaceId === 'string'
            ? workspaceId
            : `workspace ${config.logAnalyticsConfiguration.customerId}`,
        via: 'Container Apps environment logging (tables ContainerAppConsoleLogs_CL, ContainerAppSystemLogs_CL)',
        queryWith: 'azure_containerapp_logs',
      },
    ];
  }
  if (config?.destination === 'azure-monitor') {
    return diagnosticDestinations(ctx, envId, 'environment diagnostic setting');
  }
  return [];
}

function unsupportedNote(error: unknown, what: string): string {
  if (error instanceof AzureApiError && (error.status === 400 || error.status === 404)) {
    return `${what}: not supported for this resource type.`;
  }
  return `${what}: could not be read (${error instanceof Error ? error.message : String(error)}).`;
}
