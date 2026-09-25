import { z } from 'zod';
import {
  getSite,
  isLinux,
  parseSiteId,
  scmHost,
  tailKuduFile,
  WEB_API_VERSION,
  type KuduFile,
} from '../azure/appService.js';
import { AzureApiError, ToolInputError } from '../azure/errors.js';
import type { AzureHttp } from '../azure/http.js';
import { compact, limitSchema, resourceIdSchema } from './common.js';
import { defineTool } from './types.js';

const SITE_CONFIG_FIELDS = [
  'linuxFxVersion',
  'windowsFxVersion',
  'netFrameworkVersion',
  'javaVersion',
  'nodeVersion',
  'pythonVersion',
  'phpVersion',
  'powerShellVersion',
  'appCommandLine',
  'alwaysOn',
  'healthCheckPath',
  'numberOfWorkers',
  'use32BitWorkerProcess',
  'http20Enabled',
  'minTlsVersion',
  'ftpsState',
  'webSocketsEnabled',
  'autoHealEnabled',
  'detailedErrorLoggingEnabled',
  'httpLoggingEnabled',
  'requestTracingEnabled',
  'vnetRouteAllEnabled',
  'functionAppScaleLimit',
  'minimumElasticInstanceCount',
  'preWarmedInstanceCount',
] as const;

interface Deployment {
  name?: string;
  properties?: {
    status?: number;
    message?: string;
    author?: string;
    deployer?: string;
    start_time?: string;
    end_time?: string;
    active?: boolean;
  };
}

/** Kudu deployment status codes. */
const DEPLOYMENT_STATUS: Record<number, string> = {
  0: 'Pending',
  1: 'Building',
  2: 'Deploying',
  3: 'Failed',
  4: 'Success',
};

export const appServiceOverviewTool = defineTool({
  name: 'azure_appservice_overview',
  title: 'App Service overview',
  description: [
    'Summarizes an App Service or Function app (or a deployment slot) for debugging: state, runtime stack, plan and scale, key configuration (Always On, health check, TLS, workers), logging settings, slots, recent deployments and, for Function apps, the functions.',
    'App setting and connection string values are never read.',
  ].join(' '),
  inputSchema: z.object({
    resourceId: resourceIdSchema('Resource ID of a Microsoft.Web/sites app or sites/slots slot.'),
  }),
  async run(input, ctx) {
    const resource = parseSiteId(input.resourceId);
    const get = <T>(path: string) =>
      ctx.arm.request<T>({ method: 'GET', path, apiVersion: WEB_API_VERSION, signal: ctx.signal });
    const optional = <T>(promise: Promise<T>) => promise.catch(() => undefined);

    const site = await getSite(ctx.arm, resource.id, ctx.signal);
    const isFunctionApp = (site.kind ?? '').toLowerCase().includes('functionapp');
    const isSlot = resource.type.toLowerCase().endsWith('/slots');

    const [config, logs, plan, slots, deployments, functions] = await Promise.all([
      optional(get<{ properties?: Record<string, unknown> }>(`${resource.id}/config/web`)),
      optional(get<{ properties?: Record<string, unknown> }>(`${resource.id}/config/logs`)),
      site.properties.serverFarmId
        ? optional(
            get<{
              sku?: { name?: string; tier?: string; capacity?: number };
              properties?: { status?: string; numberOfSites?: number };
            }>(site.properties.serverFarmId),
          )
        : undefined,
      isSlot
        ? undefined
        : optional(
            ctx.arm.list<{ name?: string; properties?: { state?: string } }>(
              { path: `${resource.id}/slots`, apiVersion: WEB_API_VERSION, signal: ctx.signal },
              20,
            ),
          ),
      optional(
        ctx.arm.list<Deployment>(
          { path: `${resource.id}/deployments`, apiVersion: WEB_API_VERSION, signal: ctx.signal },
          50,
        ),
      ),
      isFunctionApp
        ? optional(
            ctx.arm.list<{
              name?: string;
              properties?: {
                isDisabled?: boolean;
                language?: string;
                config?: { bindings?: { type?: string }[] };
              };
            }>(
              { path: `${resource.id}/functions`, apiVersion: WEB_API_VERSION, signal: ctx.signal },
              100,
            ),
          )
        : undefined,
    ]);

    const siteConfig = config?.properties ?? {};
    const p = site.properties;
    const recentDeployments = (deployments?.items ?? [])
      .sort((a, b) =>
        String(b.properties?.start_time).localeCompare(String(a.properties?.start_time)),
      )
      .slice(0, 5)
      .map((d) =>
        compact({
          id: d.name,
          status: DEPLOYMENT_STATUS[d.properties?.status ?? -1] ?? d.properties?.status,
          active: d.properties?.active,
          started: d.properties?.start_time,
          finished: d.properties?.end_time,
          author: d.properties?.author,
          deployer: d.properties?.deployer,
          message: d.properties?.message?.slice(0, 300),
        }),
      );

    const data = compact({
      id: site.id,
      kind: site.kind,
      location: site.location,
      state: p.state,
      enabled: p.enabled,
      availabilityState: p.availabilityState,
      usageState: p.usageState,
      defaultHostName: p.defaultHostName,
      httpsOnly: p.httpsOnly,
      clientCertEnabled: p.clientCertEnabled,
      lastModified: p.lastModifiedTimeUtc,
      plan: plan
        ? compact({
            id: p.serverFarmId,
            sku: plan.sku?.name,
            tier: plan.sku?.tier,
            instances: plan.sku?.capacity,
            status: plan.properties?.status,
            appsOnPlan: plan.properties?.numberOfSites,
          })
        : p.serverFarmId,
      config: compact(Object.fromEntries(SITE_CONFIG_FIELDS.map((f) => [f, siteConfig[f]]))),
      ipRestrictions: Array.isArray(siteConfig.ipSecurityRestrictions)
        ? siteConfig.ipSecurityRestrictions.length
        : undefined,
      logging: logs?.properties,
      slots: slots?.items.map((s) => ({ name: s.name, state: s.properties?.state })),
      recentDeployments,
      functions: functions?.items.map((f) =>
        compact({
          name: f.name?.split('/').at(-1),
          disabled: f.properties?.isDisabled,
          language: f.properties?.language,
          trigger: f.properties?.config?.bindings?.find((b) =>
            b.type?.toLowerCase().endsWith('trigger'),
          )?.type,
        }),
      ),
    });

    const runtime =
      [siteConfig.linuxFxVersion, siteConfig.windowsFxVersion, siteConfig.netFrameworkVersion].find(
        (v): v is string => typeof v === 'string' && v !== '',
      ) ?? 'unknown runtime';
    const lastDeploy = recentDeployments[0];
    return {
      untrusted: true,
      summary: [
        `${site.name} (${site.kind ?? 'app'}) is ${p.state ?? 'unknown'}, ${runtime}, plan ${plan?.sku?.name ?? '?'} x${plan?.sku?.capacity ?? '?'}.`,
        siteConfig.alwaysOn === false && !isFunctionApp ? 'Always On is off.' : '',
        siteConfig.healthCheckPath ? '' : 'No health check configured.',
        lastDeploy
          ? `Last deployment: ${String(lastDeploy.status)} at ${String(lastDeploy.started)}.`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
      data,
    };
  },
});

export const appServiceLogsTool = defineTool({
  name: 'azure_appservice_logs',
  title: 'App Service logs',
  description: [
    'Reads the most recent log lines of an App Service or Function app from its log files (Kudu).',
    'Linux: source "app" is the container stdout/stderr (your application output), "platform" is container start, stop and crash events.',
    'Windows: "app" is application logging (must be enabled), "platform" is the Windows event log (IIS and runtime errors).',
    'For logs older than the files on disk, use azure_logs_query.',
  ].join(' '),
  inputSchema: z.object({
    resourceId: resourceIdSchema('Resource ID of a Microsoft.Web/sites app or sites/slots slot.'),
    source: z.enum(['app', 'platform']).default('app').describe('Which log to read (default app).'),
    lines: limitSchema(100, 1000, 'lines per instance'),
  }),
  async run(input, ctx) {
    const site = await getSite(ctx.arm, input.resourceId, ctx.signal);
    const base = `https://${scmHost(site)}`;

    let files: KuduFile[];
    try {
      files = isLinux(site)
        ? await linuxLogFiles(ctx, base, input.source)
        : await windowsLogFiles(ctx, base, input.source);
    } catch (error) {
      if (error instanceof AzureApiError && error.status === 404) files = [];
      else if (error instanceof AzureApiError && (error.status === 401 || error.status === 403)) {
        throw new ToolInputError(
          `Kudu refused access to the log files of ${site.name} (${String(error.status)}). Reading them requires a role with Microsoft.Web/sites/publish/Action on the app, such as Website Contributor; Reader is not enough. Alternatives: azure_diagnostics, or azure_logs_query if diagnostic settings send AppServiceConsoleLogs to a workspace.`,
        );
      } else throw error;
    }

    if (files.length === 0) {
      const hint = isLinux(site)
        ? 'The app may not have started yet, or logs were rotated away.'
        : 'Enable "Application logging (Filesystem)" under App Service logs, or use azure_logs_query.';
      return {
        untrusted: true,
        summary: `No ${input.source} log files found for ${site.name}. ${hint}`,
        data: { files: [] },
      };
    }

    const logs = await Promise.all(
      files.map(async (file) => ({
        file: file.name,
        modified: file.modified,
        lines: await tailKuduFile(ctx.http, file.href, file.size, input.lines, ctx.signal),
      })),
    );
    const lineCount = logs.reduce((n, l) => n + l.lines.length, 0);
    return {
      untrusted: true,
      summary: `Last ${lineCount} ${input.source} log lines of ${site.name} from ${logs.length} file(s), oldest first.`,
      data: { logs },
      listKey: 'logs',
    };
  },
});

interface KuduContext {
  http: AzureHttp;
  signal: AbortSignal;
}

interface DockerLogEntry {
  machineName?: string;
  lastUpdated?: string;
  size?: number;
  href?: string;
  path?: string;
}

interface VfsEntry {
  name?: string;
  size?: number;
  mtime?: string;
  href?: string;
  mime?: string;
}

async function linuxLogFiles(
  ctx: KuduContext,
  base: string,
  source: 'app' | 'platform',
): Promise<KuduFile[]> {
  const entries = await ctx.http.json<DockerLogEntry[]>({
    url: `${base}/api/logs/docker`,
    signal: ctx.signal,
  });
  const wanted = entries.filter((e) => {
    const name = (e.path ?? e.href ?? '').toLowerCase();
    return source === 'app'
      ? name.endsWith('_default_docker.log')
      : name.endsWith('_docker.log') && !name.endsWith('_default_docker.log');
  });
  // The newest file per instance, at most three instances.
  const newestPerMachine = new Map<string, DockerLogEntry>();
  for (const entry of wanted) {
    const key = entry.machineName ?? '';
    const current = newestPerMachine.get(key);
    if (!current || String(entry.lastUpdated) > String(current.lastUpdated))
      newestPerMachine.set(key, entry);
  }
  return [...newestPerMachine.values()]
    .sort((a, b) => String(b.lastUpdated).localeCompare(String(a.lastUpdated)))
    .slice(0, 3)
    .filter((e) => e.href)
    .map((e) => ({
      name: (e.path ?? e.href ?? '').split('/').at(-1) ?? '',
      size: e.size ?? 0,
      modified: e.lastUpdated ?? '',
      href: e.href ?? '',
    }));
}

async function windowsLogFiles(
  ctx: KuduContext,
  base: string,
  source: 'app' | 'platform',
): Promise<KuduFile[]> {
  if (source === 'platform') {
    const entries = await ctx.http.json<VfsEntry[]>({
      url: `${base}/api/vfs/LogFiles/`,
      signal: ctx.signal,
    });
    const eventLog = entries.find((e) => e.name?.toLowerCase() === 'eventlog.xml');
    return eventLog?.href
      ? [
          {
            name: 'eventlog.xml',
            size: eventLog.size ?? 0,
            modified: eventLog.mtime ?? '',
            href: eventLog.href,
          },
        ]
      : [];
  }
  const entries = await ctx.http.json<VfsEntry[]>({
    url: `${base}/api/vfs/LogFiles/Application/`,
    signal: ctx.signal,
  });
  const newest = entries
    .filter((e) => e.mime !== 'inode/directory' && /\.(txt|log)$/i.test(e.name ?? ''))
    .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))[0];
  return newest?.href
    ? [
        {
          name: newest.name ?? '',
          size: newest.size ?? 0,
          modified: newest.mtime ?? '',
          href: newest.href,
        },
      ]
    : [];
}
