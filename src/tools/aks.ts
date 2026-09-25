import { z } from 'zod';
import { AzureApiError, ToolInputError } from '../azure/errors.js';
import {
  AKS_API_VERSION,
  containerInsightsHint,
  K8S_NAME,
  KubernetesAccessError,
} from '../azure/kubernetes.js';
import { compact, limitSchema, resourceIdSchema } from './common.js';
import { defineTool } from './types.js';

const clusterIdSchema = resourceIdSchema(
  'Resource ID of a Microsoft.ContainerService/managedClusters AKS cluster.',
);
const k8sName = (what: string) =>
  z
    .string()
    .trim()
    .regex(K8S_NAME, `Expected a Kubernetes ${what} name.`)
    .describe(`Kubernetes ${what} name.`);

export const aksOverviewTool = defineTool({
  name: 'azure_aks_overview',
  title: 'AKS cluster overview',
  description: [
    'Summarizes an AKS cluster from Azure Resource Manager: power and provisioning state, Kubernetes version and available upgrades, node pools (size, count, autoscaling, state), networking, identity and access mode, and enabled add-ons such as Container Insights.',
    'Also tells whether azure_aks_workloads and azure_aks_pod_logs can reach this cluster.',
  ].join(' '),
  inputSchema: z.object({ clusterId: clusterIdSchema }),
  async run(input, ctx) {
    const cluster = await ctx.kubernetes.getCluster(input.clusterId, ctx.signal);
    const upgrades = await ctx.arm
      .request<{
        properties?: {
          controlPlaneProfile?: {
            upgrades?: { kubernetesVersion?: string; isPreview?: boolean }[];
          };
        };
      }>({
        method: 'GET',
        path: `${cluster.id}/upgradeProfiles/default`,
        apiVersion: AKS_API_VERSION,
        signal: ctx.signal,
      })
      .catch(() => undefined);

    const p = cluster.properties as Record<string, unknown> & typeof cluster.properties;
    const pools = (p.agentPoolProfiles as Record<string, unknown>[] | undefined) ?? [];
    const addons = (p.addonProfiles as Record<string, { enabled?: boolean }> | undefined) ?? {};
    const network = (p.networkProfile as Record<string, unknown> | undefined) ?? {};
    const entra = Boolean(p.aadProfile);
    const isPrivate = p.apiServerAccessProfile?.enablePrivateCluster === true;

    const kubernetesAccess = !entra
      ? `Not available: the cluster does not use Entra ID integration. ${containerInsightsHint(cluster.id)}`
      : isPrivate
        ? 'Private cluster: the API server is only reachable from its virtual network. If this machine is not connected to it, use Container Insights through azure_logs_query.'
        : `Available with your Entra ID account${p.aadProfile?.enableAzureRBAC ? ' (Azure RBAC for Kubernetes: needs "Azure Kubernetes Service RBAC Reader" or higher)' : ' (Kubernetes RBAC)'}.`;

    const available =
      upgrades?.properties?.controlPlaneProfile?.upgrades
        ?.filter((u) => !u.isPreview)
        .map((u) => u.kubernetesVersion) ?? [];
    const notRunning = pools.filter(
      (pool) =>
        (pool.powerState as { code?: string } | undefined)?.code !== 'Running' ||
        pool.provisioningState !== 'Succeeded',
    );

    return {
      summary: [
        `${cluster.name} is ${p.powerState?.code ?? 'unknown'} (provisioning ${p.provisioningState ?? '?'}), Kubernetes ${p.currentKubernetesVersion ?? p.kubernetesVersion ?? '?'}, ${pools.length} node pool(s).`,
        notRunning.length
          ? `Node pools not running or not succeeded: ${notRunning.map((n) => String(n.name)).join(', ')}.`
          : '',
        available.length ? `Upgrades available: ${available.join(', ')}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
      data: compact({
        id: cluster.id,
        location: cluster.location,
        powerState: p.powerState?.code,
        provisioningState: p.provisioningState,
        kubernetesVersion: p.currentKubernetesVersion ?? p.kubernetesVersion,
        availableUpgrades: available,
        sku: p.sku,
        fqdn: p.fqdn ?? p.privateFQDN,
        privateCluster: isPrivate,
        entraId: entra ? compact({ azureRbac: p.aadProfile?.enableAzureRBAC }) : false,
        localAccountsDisabled: p.disableLocalAccounts,
        kubernetesAccess,
        nodePools: pools.map((pool) =>
          compact({
            name: pool.name,
            mode: pool.mode,
            vmSize: pool.vmSize,
            count: pool.count,
            autoscale: pool.enableAutoScaling
              ? `${String(pool.minCount)}-${String(pool.maxCount)}`
              : undefined,
            os: pool.osType,
            version: pool.currentOrchestratorVersion ?? pool.orchestratorVersion,
            powerState: (pool.powerState as { code?: string } | undefined)?.code,
            provisioningState: pool.provisioningState,
            zones: pool.availabilityZones,
          }),
        ),
        network: compact({
          plugin: network.networkPlugin,
          pluginMode: network.networkPluginMode,
          policy: network.networkPolicy,
          outboundType: network.outboundType,
          serviceCidr: network.serviceCidr,
          podCidr: network.podCidr,
        }),
        addons: Object.entries(addons)
          .filter(([, a]) => a.enabled)
          .map(([name]) => name),
      }),
    };
  },
});

interface PodList {
  items?: Pod[];
}

interface ContainerStatus {
  name?: string;
  ready?: boolean;
  restartCount?: number;
  image?: string;
  state?: Record<
    string,
    { reason?: string; message?: string; exitCode?: number; startedAt?: string }
  >;
  lastState?: Record<string, { reason?: string; exitCode?: number; finishedAt?: string }>;
}

interface Pod {
  metadata?: {
    name?: string;
    namespace?: string;
    creationTimestamp?: string;
    ownerReferences?: { kind?: string; name?: string }[];
  };
  spec?: { nodeName?: string };
  status?: {
    phase?: string;
    reason?: string;
    message?: string;
    startTime?: string;
    conditions?: { type?: string; status?: string; reason?: string; message?: string }[];
    containerStatuses?: ContainerStatus[];
    initContainerStatuses?: ContainerStatus[];
  };
}

interface KubeEvent {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: string;
  eventTime?: string;
  firstTimestamp?: string;
  metadata?: { namespace?: string; creationTimestamp?: string };
  involvedObject?: { kind?: string; name?: string };
}

interface Deployment {
  metadata?: { name?: string; namespace?: string };
  spec?: { replicas?: number };
  status?: {
    readyReplicas?: number;
    availableReplicas?: number;
    updatedReplicas?: number;
    unavailableReplicas?: number;
    conditions?: { type?: string; status?: string; reason?: string; message?: string }[];
  };
}

interface Node {
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: { unschedulable?: boolean };
  status?: {
    conditions?: { type?: string; status?: string; reason?: string; message?: string }[];
    nodeInfo?: { kubeletVersion?: string };
    allocatable?: Record<string, string>;
  };
}

const BAD_WAITING =
  /CrashLoopBackOff|ImagePullBackOff|ErrImagePull|CreateContainerConfigError|CreateContainerError|InvalidImageName|RunContainerError/;

export const aksWorkloadsTool = defineTool({
  name: 'azure_aks_workloads',
  title: 'AKS workloads',
  description: [
    "Reads live workload state from an AKS cluster's Kubernetes API with your Entra ID account (read-only).",
    'view "problems" (default) returns only what needs attention: failing or restarting pods, recent Warning events, deployments that are not fully available, and nodes that are not ready.',
    'Other views list everything: "pods", "events", "deployments", "nodes". Optionally limit to one namespace.',
  ].join(' '),
  inputSchema: z.object({
    clusterId: clusterIdSchema,
    view: z
      .enum(['problems', 'pods', 'events', 'deployments', 'nodes'])
      .default('problems')
      .describe('What to show (default problems).'),
    namespace: k8sName('namespace').optional(),
    limit: limitSchema(100, 500, 'items per list'),
  }),
  async run(input, ctx) {
    const ns = input.namespace;
    const inNamespace = (resource: string, group = '/api/v1') =>
      ns ? `${group}/namespaces/${ns}/${resource}` : `${group}/${resource}`;
    const get = <T>(path: string, query: Record<string, string> = {}) =>
      kube(input.clusterId, () =>
        ctx.kubernetes.getJson<T>(input.clusterId, path, { limit: '500', ...query }, ctx.signal),
      );

    const want = (view: string) => input.view === view || input.view === 'problems';
    const [pods, events, deployments, nodes] = await Promise.all([
      want('pods') ? get<PodList>(inNamespace('pods')) : undefined,
      want('events')
        ? get<{ items?: KubeEvent[] }>(
            inNamespace('events'),
            input.view === 'problems' ? { fieldSelector: 'type=Warning' } : {},
          )
        : undefined,
      want('deployments')
        ? get<{ items?: Deployment[] }>(inNamespace('deployments', '/apis/apps/v1'))
        : undefined,
      want('nodes') && !ns ? get<{ items?: Node[] }>('/api/v1/nodes') : undefined,
    ]);

    const podRows = (pods?.items ?? []).map(describePod);
    const eventRows = (events?.items ?? [])
      .map((e) =>
        compact({
          time: e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? e.metadata?.creationTimestamp,
          type: e.type,
          namespace: e.metadata?.namespace,
          object: `${e.involvedObject?.kind ?? '?'}/${e.involvedObject?.name ?? '?'}`,
          reason: e.reason,
          message: e.message?.slice(0, 400),
          count: e.count,
        }),
      )
      .sort((a, b) => String(b.time).localeCompare(String(a.time)));
    const deploymentRows = (deployments?.items ?? []).map((d) =>
      compact({
        namespace: d.metadata?.namespace,
        name: d.metadata?.name,
        desired: d.spec?.replicas ?? 0,
        ready: d.status?.readyReplicas ?? 0,
        available: d.status?.availableReplicas ?? 0,
        updated: d.status?.updatedReplicas ?? 0,
        failingConditions: d.status?.conditions
          ?.filter((c) => c.status !== 'True')
          .map((c) => `${c.type ?? '?'}: ${c.reason ?? ''} ${c.message ?? ''}`.trim()),
      }),
    );
    const nodeRows = (nodes?.items ?? []).map((n) => {
      const ready = n.status?.conditions?.find((c) => c.type === 'Ready');
      return compact({
        name: n.metadata?.name,
        pool:
          n.metadata?.labels?.agentpool ?? n.metadata?.labels?.['kubernetes.azure.com/agentpool'],
        ready: ready?.status === 'True',
        unschedulable: n.spec?.unschedulable,
        pressure: n.status?.conditions
          ?.filter((c) => c.type !== 'Ready' && c.status === 'True')
          .map((c) => c.type),
        kubelet: n.status?.nodeInfo?.kubeletVersion,
        notReadyReason: ready?.status === 'True' ? undefined : ready?.message,
      });
    });

    const limit = <T>(rows: T[]) => rows.slice(0, input.limit);
    if (input.view !== 'problems') {
      const rows = {
        pods: podRows,
        events: eventRows,
        deployments: deploymentRows,
        nodes: nodeRows,
      }[input.view];
      return {
        untrusted: true,
        summary: `${rows.length} ${input.view}${ns ? ` in namespace ${ns}` : ''}.`,
        data: { [input.view]: limit(rows as unknown[]) },
        listKey: input.view,
      };
    }

    const badPods = podRows.filter((p) => p.problem !== undefined);
    const badDeployments = deploymentRows.filter((d) => (d.available ?? 0) < (d.desired ?? 0));
    const badNodes = nodeRows.filter(
      (n) => n.ready !== true || n.unschedulable || n.pressure?.length,
    );
    const recentWarnings = eventRows.slice(0, 30);
    const summary =
      badPods.length + badDeployments.length + badNodes.length + recentWarnings.length === 0
        ? `No problems found${ns ? ` in namespace ${ns}` : ''}: ${podRows.length} pods, ${deploymentRows.length} deployments and ${nodeRows.length} nodes look healthy, no Warning events.`
        : `${badPods.length} problem pod(s), ${badDeployments.length} deployment(s) not fully available, ${badNodes.length} node(s) with issues, ${eventRows.length} Warning event(s)${ns ? ` in namespace ${ns}` : ''}.`;

    return {
      untrusted: true,
      summary,
      data: {
        pods: limit(badPods),
        deployments: limit(badDeployments),
        nodes: limit(badNodes),
        warningEvents: recentWarnings,
      },
      listKey: 'warningEvents',
    };
  },
});

export const aksPodLogsTool = defineTool({
  name: 'azure_aks_pod_logs',
  title: 'AKS pod logs',
  description: [
    'Reads the last log lines of a pod container in an AKS cluster through the Kubernetes API (read-only).',
    'Set previous to true to read the logs of the previous, crashed instance of a container in CrashLoopBackOff.',
    'Find pod names with azure_aks_workloads.',
  ].join(' '),
  inputSchema: z.object({
    clusterId: clusterIdSchema,
    namespace: k8sName('namespace'),
    pod: k8sName('pod'),
    container: k8sName('container')
      .optional()
      .describe('Container name. Required when the pod has more than one container.'),
    previous: z
      .boolean()
      .default(false)
      .describe('Read logs of the previous (crashed) container instance.'),
    tailLines: limitSchema(200, 2000, 'lines'),
    sinceMinutes: z
      .number()
      .int()
      .min(1)
      .max(10_080)
      .optional()
      .describe('Only lines from the last N minutes.'),
  }),
  async run(input, ctx) {
    const text = await kube(input.clusterId, () =>
      ctx.kubernetes.getText(
        input.clusterId,
        `/api/v1/namespaces/${input.namespace}/pods/${input.pod}/log`,
        {
          tailLines: String(input.tailLines),
          timestamps: 'true',
          limitBytes: String(512 * 1024),
          ...(input.container ? { container: input.container } : {}),
          ...(input.previous ? { previous: 'true' } : {}),
          ...(input.sinceMinutes ? { sinceSeconds: String(input.sinceMinutes * 60) } : {}),
        },
        ctx.signal,
      ),
    );
    const lines = text.split('\n').filter((l) => l !== '');
    return {
      untrusted: true,
      summary:
        lines.length === 0
          ? `No log output from ${input.namespace}/${input.pod}${input.container ? ` (${input.container})` : ''}${input.previous ? ' previous instance' : ''}.`
          : `Last ${lines.length} log lines from ${input.namespace}/${input.pod}${input.container ? ` (${input.container})` : ''}${input.previous ? ', previous instance' : ''}, oldest first.`,
      data: { lines },
      listKey: 'lines',
    };
  },
});

function describePod(pod: Pod) {
  const statuses = [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ];
  const main = pod.status?.containerStatuses ?? [];
  const restarts = main.reduce((n, c) => n + (c.restartCount ?? 0), 0);
  const waiting = statuses.map((c) => c.state?.waiting?.reason).find((r) => r !== undefined);
  const terminated = statuses.map((c) => c.state?.terminated).find((t) => t && t.exitCode !== 0);
  const lastTermination = main.map((c) => c.lastState?.terminated).find((t) => t !== undefined);
  const unschedulable = pod.status?.conditions?.find(
    (c) => c.type === 'PodScheduled' && c.status === 'False',
  );
  const readyCount = main.filter((c) => c.ready).length;
  const phase = pod.status?.phase;

  let problem: string | undefined;
  if (waiting && BAD_WAITING.test(waiting)) problem = waiting;
  else if (unschedulable)
    problem = `Unschedulable: ${unschedulable.message ?? unschedulable.reason ?? ''}`;
  else if (phase === 'Failed' || phase === 'Unknown')
    problem = `${phase}${pod.status?.reason ? `: ${pod.status.reason}` : ''}`;
  else if (terminated)
    problem = `Terminated: ${terminated.reason ?? ''} (exit ${String(terminated.exitCode)})`;
  else if (phase === 'Pending') problem = `Pending${waiting ? `: ${waiting}` : ''}`;
  else if (phase === 'Running' && readyCount < main.length) problem = 'Not ready';
  else if (restarts >= 3) problem = `Restarted ${restarts} times`;

  return compact({
    namespace: pod.metadata?.namespace,
    name: pod.metadata?.name,
    phase,
    ready: `${readyCount}/${main.length}`,
    restarts,
    problem,
    lastTermination: lastTermination
      ? compact({
          reason: lastTermination.reason,
          exitCode: lastTermination.exitCode,
          at: lastTermination.finishedAt,
        })
      : undefined,
    node: pod.spec?.nodeName,
    owner: pod.metadata?.ownerReferences?.[0]
      ? `${pod.metadata.ownerReferences[0].kind ?? ''}/${pod.metadata.ownerReferences[0].name ?? ''}`
      : undefined,
    started: pod.status?.startTime,
  });
}

/** Adds AKS-specific guidance to Kubernetes API failures. */
async function kube<T>(clusterId: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof KubernetesAccessError) throw error;
    if (error instanceof AzureApiError && (error.status === 401 || error.status === 403)) {
      throw new ToolInputError(
        `The Kubernetes API refused access (${String(error.status)}): ${error.azureMessage} Your account needs read access in the cluster: the "Azure Kubernetes Service RBAC Reader" role (Azure RBAC clusters) or a Kubernetes RoleBinding to "view".`,
      );
    }
    if (error instanceof AzureApiError) throw error;
    if (
      error instanceof Error &&
      /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|certificate/i.test(
        `${error.message} ${(error as { code?: string }).code ?? ''}`,
      )
    ) {
      throw new ToolInputError(
        `Could not reach the cluster's API server (${error.message}). Private clusters are only reachable from their network. ${containerInsightsHint(clusterId)}`,
      );
    }
    throw error;
  }
}
