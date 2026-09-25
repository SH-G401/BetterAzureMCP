import { z } from 'zod';
import { ToolInputError } from '../azure/errors.js';
import { parseResourceId } from '../azure/resourceId.js';
import { kqlString, queryResourceGraph } from '../azure/resourceGraph.js';
import { compact, hoursSchema, limitSchema, resourceIdSchema, searchTextSchema } from './common.js';
import { defineTool, type ToolContext } from './types.js';

const API_VERSION = '2024-03-01';

interface ContainerApp {
  id: string;
  name: string;
  location: string;
  properties: {
    provisioningState?: string;
    runningStatus?: string;
    environmentId?: string;
    managedEnvironmentId?: string;
    latestRevisionName?: string;
    latestReadyRevisionName?: string;
    latestRevisionFqdn?: string;
    configuration?: {
      activeRevisionsMode?: string;
      ingress?: {
        fqdn?: string;
        external?: boolean;
        targetPort?: number;
        transport?: string;
        traffic?: unknown[];
      };
    };
    template?: {
      containers?: {
        name?: string;
        image?: string;
        resources?: { cpu?: number; memory?: string };
        probes?: { type?: string }[];
      }[];
      scale?: { minReplicas?: number; maxReplicas?: number; rules?: { name?: string }[] };
    };
  };
}

interface Revision {
  name?: string;
  properties?: {
    active?: boolean;
    createdTime?: string;
    healthState?: string;
    runningState?: string;
    provisioningState?: string;
    provisioningError?: string;
    replicas?: number;
    trafficWeight?: number;
  };
}

interface Replica {
  name?: string;
  properties?: {
    createdTime?: string;
    runningState?: string;
    runningStateDetails?: string;
    containers?: {
      name?: string;
      ready?: boolean;
      started?: boolean;
      restartCount?: number;
      runningState?: string;
      runningStateDetails?: string;
    }[];
  };
}

function parseContainerAppId(resourceId: string) {
  const resource = parseResourceId(resourceId);
  if (resource.type.toLowerCase() !== 'microsoft.app/containerapps') {
    throw new ToolInputError(`${resourceId} is not a Container App (Microsoft.App/containerApps).`);
  }
  return resource;
}

export const containerAppOverviewTool = defineTool({
  name: 'azure_containerapp_overview',
  title: 'Container App overview',
  description: [
    'Summarizes a Container App for debugging: provisioning and running state, ingress, containers (image, CPU, memory, probes), scale rules, revisions with health and traffic, and the replicas of active revisions with container restart counts and states.',
    'Use azure_containerapp_logs for console and system logs.',
  ].join(' '),
  inputSchema: z.object({
    resourceId: resourceIdSchema('Resource ID of a Microsoft.App/containerApps app.'),
  }),
  async run(input, ctx) {
    const resource = parseContainerAppId(input.resourceId);
    const [app, revisions] = await Promise.all([
      ctx.arm.request<ContainerApp>({
        method: 'GET',
        path: resource.id,
        apiVersion: API_VERSION,
        signal: ctx.signal,
      }),
      ctx.arm.list<Revision>(
        { path: `${resource.id}/revisions`, apiVersion: API_VERSION, signal: ctx.signal },
        50,
      ),
    ]);

    const active = revisions.items.filter((r) => r.properties?.active).slice(0, 3);
    const replicas = await Promise.all(
      active.map(async (revision) => ({
        revision: revision.name,
        replicas: await ctx.arm
          .list<Replica>(
            {
              path: `${resource.id}/revisions/${revision.name ?? ''}/replicas`,
              apiVersion: API_VERSION,
              signal: ctx.signal,
            },
            30,
          )
          .then((page) =>
            page.items.map((r) =>
              compact({
                name: r.name,
                created: r.properties?.createdTime,
                state: r.properties?.runningState,
                detail: r.properties?.runningStateDetails,
                containers: r.properties?.containers?.map((c) =>
                  compact({
                    name: c.name,
                    ready: c.ready,
                    restarts: c.restartCount,
                    state: c.runningState,
                    detail: c.runningStateDetails,
                  }),
                ),
              }),
            ),
          )
          .catch(() => []),
      })),
    );

    const p = app.properties;
    const restarts = replicas
      .flatMap((r) => r.replicas)
      .flatMap((r) => r.containers ?? [])
      .reduce((n, c) => n + (typeof c.restarts === 'number' ? c.restarts : 0), 0);
    const unhealthy = revisions.items.filter(
      (r) =>
        r.properties?.active && r.properties.healthState && r.properties.healthState !== 'Healthy',
    );

    return {
      summary: [
        `${app.name} is ${p.runningStatus ?? 'unknown'} (provisioning ${p.provisioningState ?? '?'}), latest revision ${p.latestRevisionName ?? '?'} (ready: ${p.latestReadyRevisionName ?? 'none'}).`,
        `${active.length} active revision(s), ${replicas.reduce((n, r) => n + r.replicas.length, 0)} replica(s), ${restarts} container restart(s).`,
        unhealthy.length
          ? `Unhealthy: ${unhealthy.map((r) => `${r.name ?? '?'} (${r.properties?.healthState ?? '?'})`).join(', ')}.`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
      data: compact({
        id: app.id,
        location: app.location,
        environmentId: p.environmentId ?? p.managedEnvironmentId,
        provisioningState: p.provisioningState,
        runningStatus: p.runningStatus,
        revisionsMode: p.configuration?.activeRevisionsMode,
        ingress: p.configuration?.ingress
          ? compact({
              fqdn: p.configuration.ingress.fqdn,
              external: p.configuration.ingress.external,
              targetPort: p.configuration.ingress.targetPort,
              transport: p.configuration.ingress.transport,
              traffic: p.configuration.ingress.traffic,
            })
          : undefined,
        containers: p.template?.containers?.map((c) =>
          compact({
            name: c.name,
            image: c.image,
            cpu: c.resources?.cpu,
            memory: c.resources?.memory,
            probes: c.probes?.map((pr) => pr.type),
          }),
        ),
        scale: p.template?.scale
          ? compact({
              min: p.template.scale.minReplicas,
              max: p.template.scale.maxReplicas,
              rules: p.template.scale.rules?.map((r) => r.name),
            })
          : undefined,
        revisions: revisions.items.slice(0, 10).map((r) =>
          compact({
            name: r.name,
            active: r.properties?.active,
            created: r.properties?.createdTime,
            health: r.properties?.healthState,
            running: r.properties?.runningState,
            provisioning: r.properties?.provisioningState,
            error: r.properties?.provisioningError,
            replicas: r.properties?.replicas,
            traffic: r.properties?.trafficWeight,
          }),
        ),
        replicas,
      }),
    };
  },
});

export const containerAppLogsTool = defineTool({
  name: 'azure_containerapp_logs',
  title: 'Container App logs',
  description: [
    "Reads recent Container App logs from the environment's Log Analytics workspace.",
    'source "console" is your containers\' stdout/stderr; "system" is platform events: revision provisioning, image pulls, probe failures, crashes and scaling.',
    'Filter by revision or by text. Results are oldest first.',
  ].join(' '),
  inputSchema: z.object({
    resourceId: resourceIdSchema('Resource ID of a Microsoft.App/containerApps app.'),
    source: z
      .enum(['console', 'system'])
      .default('console')
      .describe('Which log to read (default console).'),
    hours: hoursSchema(1, 720),
    revision: searchTextSchema('Only this revision name.').optional(),
    search: searchTextSchema('Only lines containing this text (case-insensitive).').optional(),
    limit: limitSchema(100, 1000, 'lines'),
  }),
  async run(input, ctx) {
    const resource = parseContainerAppId(input.resourceId);
    const app = await ctx.arm.request<ContainerApp>({
      method: 'GET',
      path: resource.id,
      apiVersion: API_VERSION,
      signal: ctx.signal,
    });
    const envId = app.properties.environmentId ?? app.properties.managedEnvironmentId;
    if (!envId) throw new ToolInputError(`${app.name} has no Container Apps environment.`);

    const { scope, table } = await logDestination(ctx, envId, input.source);
    // Workspace-logging tables use `_s` column suffixes; diagnostic-settings tables do not.
    // Only one of the two columns exists, so concatenating them yields the value.
    const col = (name: string) =>
      `strcat(column_ifexists('${name}_s', ''), column_ifexists('${name}', ''))`;
    const filters = [
      `| where TimeGenerated > ago(${input.hours}h)`,
      `| where tolower(tostring(${col('ContainerAppName')})) == tolower(${kqlString(app.name)})`,
      ...(input.revision
        ? [`| where tostring(${col('RevisionName')}) =~ ${kqlString(input.revision)}`]
        : []),
      ...(input.search
        ? [`| where tostring(${col('Log')}) contains ${kqlString(input.search)}`]
        : []),
    ];
    const projection =
      input.source === 'console'
        ? `| project TimeGenerated, revision = tostring(${col('RevisionName')}), replica = tostring(${col('ContainerGroupName')}), container = tostring(${col('ContainerName')}), stream = tostring(${col('Stream')}), log = tostring(${col('Log')})`
        : `| project TimeGenerated, revision = tostring(${col('RevisionName')}), replica = tostring(${col('ReplicaName')}), reason = tostring(${col('Reason')}), type = tostring(${col('Type')}), log = tostring(${col('Log')})`;

    const result = await ctx.logs.query({
      scope,
      query: [
        table,
        ...filters,
        projection,
        `| top ${input.limit} by TimeGenerated desc`,
        '| order by TimeGenerated asc',
      ].join('\n'),
      hours: input.hours,
      maxRows: input.limit,
      serverTimeoutSeconds: Math.floor(ctx.config.timeoutMs / 1000) - 5,
      signal: ctx.signal,
    });

    const rows = result.rows.map((r) =>
      Object.fromEntries(Object.entries(r).filter(([, v]) => v !== '' && v !== null)),
    );
    return {
      summary:
        rows.length === 0
          ? `No ${input.source} logs for ${app.name} in the last ${input.hours} hour(s)${input.search || input.revision ? ' matching the filters' : ''}. Logs can take a few minutes to arrive.`
          : `${rows.length} ${input.source} log lines for ${app.name} from the last ${input.hours} hour(s), oldest first.`,
      data: { lines: rows },
      listKey: 'lines',
    };
  },
});

async function logDestination(
  ctx: ToolContext,
  envId: string,
  source: 'console' | 'system',
): Promise<{ scope: string; table: string }> {
  const env = await ctx.arm.request<{
    properties?: {
      appLogsConfiguration?: {
        destination?: string;
        logAnalyticsConfiguration?: { customerId?: string };
      };
    };
  }>({ method: 'GET', path: envId, apiVersion: API_VERSION, signal: ctx.signal });
  const config = env.properties?.appLogsConfiguration;
  const baseTable = source === 'console' ? 'ContainerAppConsoleLogs' : 'ContainerAppSystemLogs';

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
    if (typeof workspaceId !== 'string') {
      throw new ToolInputError(
        "The environment's Log Analytics workspace is not visible to your account. You need read access to it.",
      );
    }
    return { scope: workspaceId, table: `${baseTable}_CL` };
  }
  if (config?.destination === 'azure-monitor') {
    // Diagnostic settings on the environment: resource-centric query on the environment.
    return { scope: envId, table: baseTable };
  }
  throw new ToolInputError(
    'The Container Apps environment does not send logs to Log Analytics, so there are no logs to read. Configure logging on the environment (Monitoring > Logging options).',
  );
}
