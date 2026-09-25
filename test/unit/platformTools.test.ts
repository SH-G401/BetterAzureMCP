import { describe, expect, it } from 'vitest';
import { parseKubeconfig } from '../../src/azure/kubernetes.js';
import { aksOverviewTool, aksPodLogsTool, aksWorkloadsTool } from '../../src/tools/aks.js';
import { appServiceLogsTool, appServiceOverviewTool } from '../../src/tools/appService.js';
import { containerAppLogsTool, containerAppOverviewTool } from '../../src/tools/containerApps.js';
import { diagnosticsTool } from '../../src/tools/diagnostics.js';
import {
  callTool,
  dataOf,
  logRows,
  RG_ID,
  servicesWith,
  type RecordedRequest,
} from '../helpers.js';

const SITE = `${RG_ID}/providers/Microsoft.Web/sites/orders-api`;
const PLAN = `${RG_ID}/providers/Microsoft.Web/serverfarms/plan`;
const APP = `${RG_ID}/providers/Microsoft.App/containerApps/orders`;
const ENV = `${RG_ID}/providers/Microsoft.App/managedEnvironments/env`;
const CLUSTER = `${RG_ID}/providers/Microsoft.ContainerService/managedClusters/aks`;
const KUDU = 'orders-api.scm.azurewebsites.net';
const API_SERVER = 'aks-dns-1a2b.hcp.westeurope.azmk8s.io';

const site = (kind: string) => ({
  id: SITE,
  name: 'orders-api',
  kind,
  location: 'westeurope',
  properties: {
    state: 'Running',
    serverFarmId: PLAN,
    hostNameSslStates: [
      { name: 'orders-api.azurewebsites.net', hostType: 'Standard' },
      { name: KUDU, hostType: 'Repository' },
    ],
  },
});

describe('azure_appservice_overview', () => {
  it('combines site, config, plan and deployments', async () => {
    const { services } = servicesWith((req) => {
      const path = req.url.pathname;
      if (path === SITE) return { body: site('app,linux') };
      if (path === `${SITE}/config/web`) {
        return {
          body: {
            properties: {
              linuxFxVersion: 'NODE|22-lts',
              alwaysOn: false,
              healthCheckPath: null,
              publishingPassword: 'x',
            },
          },
        };
      }
      if (path === PLAN) return { body: { sku: { name: 'P1v3', capacity: 2 } } };
      if (path === `${SITE}/deployments`) {
        return {
          body: {
            value: [
              { name: 'a', properties: { status: 4, start_time: '2026-09-20T10:00:00Z' } },
              {
                name: 'b',
                properties: {
                  status: 3,
                  start_time: '2026-09-25T10:00:00Z',
                  message: 'npm ci failed',
                },
              },
            ],
          },
        };
      }
      if (path === `${SITE}/slots`) return { body: { value: [] } };
      return undefined;
    });

    const { text } = await callTool(appServiceOverviewTool, { resourceId: SITE }, services);
    expect(text).toMatch(
      /^orders-api \(app,linux\) is Running, NODE\|22-lts, plan P1v3 x2\. Always On is off\. No health check configured\. Last deployment: Failed at 2026-09-25T10:00:00Z\./,
    );
    expect(text).not.toContain('publishingPassword');
  });

  it('rejects resources that are not web apps', async () => {
    const { services } = servicesWith(() => undefined);
    const { isError, text } = await callTool(appServiceOverviewTool, { resourceId: APP }, services);
    expect(isError).toBe(true);
    expect(text).toContain('is not an App Service or Function app');
  });
});

describe('azure_appservice_logs', () => {
  it('tails the newest app container log per instance on Linux', async () => {
    const { services, http } = servicesWith((req) => {
      if (req.url.pathname === SITE) return { body: site('app,linux') };
      if (req.url.hostname === KUDU && req.url.pathname === '/api/logs/docker') {
        return {
          body: [
            {
              machineName: 'm1',
              lastUpdated: '2026-09-25T09:00:00Z',
              size: 100,
              href: `https://${KUDU}/api/vfs/LogFiles/2026_09_25_m1_default_docker.log`,
              path: '/home/LogFiles/2026_09_25_m1_default_docker.log',
            },
            {
              machineName: 'm1',
              lastUpdated: '2026-09-24T09:00:00Z',
              size: 100,
              href: `https://${KUDU}/api/vfs/LogFiles/2026_09_24_m1_default_docker.log`,
              path: '/home/LogFiles/2026_09_24_m1_default_docker.log',
            },
            {
              machineName: 'm1',
              lastUpdated: '2026-09-25T09:00:00Z',
              size: 100,
              href: `https://${KUDU}/api/vfs/LogFiles/2026_09_25_m1_docker.log`,
              path: '/home/LogFiles/2026_09_25_m1_docker.log',
            },
          ],
        };
      }
      if (req.url.pathname === '/api/vfs/LogFiles/2026_09_25_m1_default_docker.log') {
        return { body: 'line 1\nline 2\nline 3\n' };
      }
      return undefined;
    });

    const { text } = await callTool(appServiceLogsTool, { resourceId: SITE, lines: 2 }, services);
    expect(text).toMatch(/^Last 2 app log lines of orders-api from 1 file/);
    const logs = (dataOf(text) as { logs: { lines: string[] }[] }).logs;
    expect(logs[0]?.lines).toEqual(['line 2', 'line 3']);
    const kuduRequest = http.requests.find((r) =>
      r.url.pathname.endsWith('.log'),
    ) as RecordedRequest;
    expect(kuduRequest.headers.range).toBe('bytes=-100');
    expect(kuduRequest.headers.authorization).toMatch(/^Bearer /);
  });

  it('explains when the app has no Kudu site', async () => {
    const { services } = servicesWith(() => ({
      body: { ...site('functionapp,linux'), properties: { state: 'Running' } },
    }));
    const { isError, text } = await callTool(appServiceLogsTool, { resourceId: SITE }, services);
    expect(isError).toBe(true);
    expect(text).toContain('has no Kudu (SCM) site');
  });
});

describe('azure_diagnostics', () => {
  it('lists detectors', async () => {
    const { services } = servicesWith(() => ({
      body: {
        value: [
          {
            properties: {
              metadata: {
                id: 'sitecrashes',
                name: 'Application Crashes',
                category: 'Availability and Performance',
              },
            },
          },
        ],
      },
    }));
    const { text } = await callTool(diagnosticsTool, { resourceId: SITE }, services);
    expect(text).toMatch(/^1 detectors available/);
  });

  it('runs a detector over the time range', async () => {
    const { services, http } = servicesWith(() => ({
      body: {
        properties: {
          metadata: { name: 'Application Crashes' },
          status: { statusId: 0, message: 'Crashes detected' },
          dataset: [
            {
              renderingProperties: { title: 'Crashes' },
              table: { columns: [{ columnName: 'ExitCode' }], rows: [['0xC00000FD']] },
            },
          ],
        },
      },
    }));
    const { text } = await callTool(
      diagnosticsTool,
      { resourceId: SITE, detector: 'sitecrashes', hours: 6 },
      services,
    );
    expect(text).toMatch(
      /^Detector "Application Crashes" on orders-api: Critical - Crashes detected\./,
    );
    expect(http.requests[0]?.url.searchParams.get('startTime')).toMatch(/^\d{4}-/);
    expect((dataOf(text) as { datasets: { rows: unknown[] }[] }).datasets[0]?.rows).toEqual([
      { ExitCode: '0xC00000FD' },
    ]);
  });

  it('rejects unsupported resource types', async () => {
    const { services } = servicesWith(() => undefined);
    const { isError } = await callTool(diagnosticsTool, { resourceId: CLUSTER }, services);
    expect(isError).toBe(true);
  });
});

describe('Container Apps tools', () => {
  const app = {
    id: APP,
    name: 'orders',
    location: 'westeurope',
    properties: {
      runningStatus: 'Running',
      provisioningState: 'Succeeded',
      environmentId: ENV,
      latestRevisionName: 'orders--v2',
      latestReadyRevisionName: 'orders--v1',
    },
  };

  it('summarizes revisions and replica restarts', async () => {
    const { services } = servicesWith((req) => {
      const path = req.url.pathname;
      if (path === APP) return { body: app };
      if (path === `${APP}/revisions`) {
        return {
          body: {
            value: [
              {
                name: 'orders--v2',
                properties: {
                  active: true,
                  healthState: 'Unhealthy',
                  provisioningState: 'Failed',
                  provisioningError: 'Probe failed',
                },
              },
              { name: 'orders--v1', properties: { active: false, healthState: 'Healthy' } },
            ],
          },
        };
      }
      if (path === `${APP}/revisions/orders--v2/replicas`) {
        return {
          body: {
            value: [
              {
                name: 'r1',
                properties: {
                  runningState: 'NotRunning',
                  containers: [{ name: 'api', ready: false, restartCount: 7 }],
                },
              },
            ],
          },
        };
      }
      return undefined;
    });

    const { text } = await callTool(containerAppOverviewTool, { resourceId: APP }, services);
    expect(text).toMatch(
      /1 active revision\(s\), 1 replica\(s\), 7 container restart\(s\)\. Unhealthy: orders--v2 \(Unhealthy\)\./,
    );
  });

  it('reads console logs from the environment workspace', async () => {
    const WORKSPACE = `${RG_ID}/providers/Microsoft.OperationalInsights/workspaces/logs`;
    const { services, http } = servicesWith((req) => {
      const path = req.url.pathname;
      if (path === APP) return { body: app };
      if (path === ENV) {
        return {
          body: {
            properties: {
              appLogsConfiguration: {
                destination: 'log-analytics',
                logAnalyticsConfiguration: { customerId: '11111111-2222-3333-4444-555555555555' },
              },
            },
          },
        };
      }
      if (path === '/providers/Microsoft.ResourceGraph/resources') {
        return {
          body: { totalRecords: 1, count: 1, data: [{ id: WORKSPACE }], resultTruncated: 'false' },
        };
      }
      if (path === WORKSPACE)
        return { body: { properties: { customerId: '11111111-2222-3333-4444-555555555555' } } };
      if (req.url.hostname === 'api.loganalytics.io')
        return logRows([{ TimeGenerated: 't', log: 'Listening on 8080', replica: '' }]);
      return undefined;
    });

    const { text } = await callTool(
      containerAppLogsTool,
      { resourceId: APP, search: 'error' },
      services,
    );
    const query = (
      http.requests.find((r) => r.url.hostname === 'api.loganalytics.io')?.body as { query: string }
    ).query;
    expect(query.startsWith('ContainerAppConsoleLogs_CL')).toBe(true);
    expect(query).toContain("== tolower(@'orders')");
    expect(query).toContain("contains @'error'");
    expect(text).toMatch(/^1 console log lines for orders/);
    expect((dataOf(text) as { lines: Record<string, unknown>[] }).lines[0]).not.toHaveProperty(
      'replica',
    );
  });
});

describe('AKS tools', () => {
  const kubeconfig = Buffer.from(
    [
      'apiVersion: v1',
      'clusters:',
      '- cluster:',
      `    certificate-authority-data: ${Buffer.from('-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----').toString('base64')}`,
      `    server: https://${API_SERVER}:443`,
      '  name: aks',
    ].join('\n'),
  ).toString('base64');

  const cluster = (entra: boolean) => ({
    id: CLUSTER,
    name: 'aks',
    location: 'westeurope',
    properties: {
      provisioningState: 'Succeeded',
      powerState: { code: 'Running' },
      currentKubernetesVersion: '1.30.3',
      fqdn: API_SERVER,
      aadProfile: entra ? { managed: true, enableAzureRBAC: true } : undefined,
      agentPoolProfiles: [
        {
          name: 'system',
          count: 3,
          vmSize: 'Standard_D4s_v5',
          mode: 'System',
          powerState: { code: 'Running' },
          provisioningState: 'Succeeded',
        },
      ],
      addonProfiles: { omsagent: { enabled: true }, azurepolicy: { enabled: false } },
    },
  });

  function aksServices(
    entra: boolean,
    kube: (req: RecordedRequest) => { status?: number; body?: unknown } | undefined,
  ) {
    return servicesWith((req) => {
      if (req.url.hostname === API_SERVER) return kube(req);
      const path = req.url.pathname;
      if (path === CLUSTER) return { body: cluster(entra) };
      if (path === `${CLUSTER}/upgradeProfiles/default`) {
        return {
          body: {
            properties: {
              controlPlaneProfile: {
                upgrades: [
                  { kubernetesVersion: '1.31.1' },
                  { kubernetesVersion: '1.32.0', isPreview: true },
                ],
              },
            },
          },
        };
      }
      if (path === `${CLUSTER}/listClusterUserCredential`)
        return { body: { kubeconfigs: [{ name: 'clusterUser', value: kubeconfig }] } };
      return undefined;
    });
  }

  it('parses kubeconfigs', () => {
    const parsed = parseKubeconfig(Buffer.from(kubeconfig, 'base64').toString('utf8'));
    expect(parsed.server).toBe(`https://${API_SERVER}:443`);
    expect(parsed.ca).toContain('BEGIN CERTIFICATE');
  });

  it('summarizes the cluster and Kubernetes access', async () => {
    const { services } = aksServices(true, () => undefined);
    const { text } = await callTool(aksOverviewTool, { clusterId: CLUSTER }, services);
    expect(text).toMatch(
      /^aks is Running \(provisioning Succeeded\), Kubernetes 1\.30\.3, 1 node pool\(s\)\. Upgrades available: 1\.31\.1\./,
    );
    const data = dataOf(text) as { addons: string[]; kubernetesAccess: string };
    expect(data.addons).toEqual(['omsagent']);
    expect(data.kubernetesAccess).toContain('Azure Kubernetes Service RBAC Reader');
  });

  it('finds problem pods, deployments and warning events', async () => {
    const { services, http } = aksServices(true, (req) => {
      switch (req.url.pathname) {
        case '/api/v1/namespaces/shop/pods':
          return {
            body: {
              items: [
                {
                  metadata: { name: 'web-1', namespace: 'shop' },
                  status: {
                    phase: 'Running',
                    containerStatuses: [{ name: 'web', ready: true, restartCount: 0 }],
                  },
                },
                {
                  metadata: { name: 'api-1', namespace: 'shop' },
                  status: {
                    phase: 'Running',
                    containerStatuses: [
                      {
                        name: 'api',
                        ready: false,
                        restartCount: 12,
                        state: { waiting: { reason: 'CrashLoopBackOff' } },
                        lastState: { terminated: { reason: 'Error', exitCode: 1 } },
                      },
                    ],
                  },
                },
              ],
            },
          };
        case '/api/v1/namespaces/shop/events':
          return {
            body: {
              items: [
                {
                  type: 'Warning',
                  reason: 'BackOff',
                  message: 'Back-off restarting failed container',
                  involvedObject: { kind: 'Pod', name: 'api-1' },
                  lastTimestamp: '2026-09-25T08:00:00Z',
                },
              ],
            },
          };
        case '/apis/apps/v1/namespaces/shop/deployments':
          return {
            body: {
              items: [
                {
                  metadata: { name: 'api', namespace: 'shop' },
                  spec: { replicas: 2 },
                  status: { readyReplicas: 1, availableReplicas: 1 },
                },
              ],
            },
          };
        default:
          return undefined;
      }
    });

    const { text } = await callTool(
      aksWorkloadsTool,
      { clusterId: CLUSTER, namespace: 'shop' },
      services,
    );
    expect(text).toMatch(
      /^1 problem pod\(s\), 1 deployment\(s\) not fully available, 0 node\(s\) with issues, 1 Warning event\(s\) in namespace shop\./,
    );
    const data = dataOf(text) as { pods: { name: string; problem: string }[] };
    expect(data.pods).toEqual([
      expect.objectContaining({ name: 'api-1', problem: 'CrashLoopBackOff' }),
    ]);

    const eventsRequest = http.requests.find((r) =>
      r.url.pathname.endsWith('/events'),
    ) as RecordedRequest;
    expect(eventsRequest.url.searchParams.get('fieldSelector')).toBe('type=Warning');
    expect(eventsRequest.headers.authorization).toMatch(/^Bearer /);
    // Nodes are cluster-scoped and skipped for a namespace view.
    expect(http.requests.some((r) => r.url.pathname === '/api/v1/nodes')).toBe(false);
  });

  it('refuses clusters without Entra ID and points to Container Insights', async () => {
    const { services, http } = aksServices(false, () => undefined);
    const { isError, text } = await callTool(aksWorkloadsTool, { clusterId: CLUSTER }, services);
    expect(isError).toBe(true);
    expect(text).toContain('does not use Entra ID integration');
    expect(text).toContain('KubePodInventory');
    expect(http.requests.some((r) => r.url.pathname.endsWith('/listClusterUserCredential'))).toBe(
      false,
    );
  });

  it('turns Kubernetes 403 into RBAC guidance', async () => {
    const { services } = aksServices(true, () => ({
      status: 403,
      body: { kind: 'Status', reason: 'Forbidden', message: 'pods is forbidden' },
    }));
    const { isError, text } = await callTool(
      aksWorkloadsTool,
      { clusterId: CLUSTER, view: 'pods' },
      services,
    );
    expect(isError).toBe(true);
    expect(text).toContain('Azure Kubernetes Service RBAC Reader');
  });

  it('reads previous pod logs', async () => {
    const { services, http } = aksServices(true, (req) =>
      req.url.pathname === '/api/v1/namespaces/shop/pods/api-1/log'
        ? { body: '2026-09-25T08:00:00Z panic: nil map\n' }
        : undefined,
    );
    const { text } = await callTool(
      aksPodLogsTool,
      { clusterId: CLUSTER, namespace: 'shop', pod: 'api-1', previous: true },
      services,
    );
    expect(text).toMatch(/^Last 1 log lines from shop\/api-1, previous instance/);
    const query = http.requests.at(-1)?.url.searchParams;
    expect(query?.get('previous')).toBe('true');
    expect(query?.get('tailLines')).toBe('200');
  });

  it('validates Kubernetes names', () => {
    expect(() =>
      aksPodLogsTool.inputSchema.parse({
        clusterId: CLUSTER,
        namespace: 'shop',
        pod: '../secrets',
      }),
    ).toThrow();
  });
});

describe('permission guidance', () => {
  it('explains the Kudu role requirement', async () => {
    const { services } = servicesWith((req) => {
      if (req.url.pathname === SITE) return { body: site('app,linux') };
      return { status: 401, body: 'Unauthorized' };
    });
    const { isError, text } = await callTool(appServiceLogsTool, { resourceId: SITE }, services);
    expect(isError).toBe(true);
    expect(text).toContain('Website Contributor');
  });

  it('explains the AKS Cluster User role requirement', async () => {
    const { services } = servicesWith((req) => {
      if (req.url.pathname === CLUSTER) {
        return {
          body: {
            id: CLUSTER,
            name: 'aks',
            location: 'westeurope',
            properties: { aadProfile: { managed: true } },
          },
        };
      }
      if (req.url.pathname.endsWith('/listClusterUserCredential')) {
        return { status: 403, body: { error: { code: 'AuthorizationFailed', message: 'no' } } };
      }
      return undefined;
    });
    const { isError, text } = await callTool(aksWorkloadsTool, { clusterId: CLUSTER }, services);
    expect(isError).toBe(true);
    expect(text).toContain('Azure Kubernetes Service Cluster User Role');
  });
});
