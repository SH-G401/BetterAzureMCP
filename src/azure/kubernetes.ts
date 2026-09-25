import type { ArmClient } from './armClient.js';
import type { AzureHttp } from './http.js';
import { AzureApiError, ToolInputError } from './errors.js';
import { parseResourceId } from './resourceId.js';

export const AKS_API_VERSION = '2024-05-01';

export interface ManagedCluster {
  id: string;
  name: string;
  location: string;
  properties: {
    provisioningState?: string;
    powerState?: { code?: string };
    kubernetesVersion?: string;
    currentKubernetesVersion?: string;
    fqdn?: string;
    privateFQDN?: string;
    aadProfile?: { managed?: boolean; enableAzureRBAC?: boolean } | null;
    disableLocalAccounts?: boolean;
    apiServerAccessProfile?: { enablePrivateCluster?: boolean; authorizedIPRanges?: string[] };
    [key: string]: unknown;
  };
}

interface Connection {
  server: string;
  ca: string;
  expires: number;
}

const CONNECTION_TTL_MS = 10 * 60_000;

/** Reason Kubernetes API access is not possible, with a fallback the model can use instead. */
export class KubernetesAccessError extends ToolInputError {
  override name = 'KubernetesAccessError';
}

/**
 * Reads from an AKS cluster's Kubernetes API with the user's Entra ID token.
 * Only clusters with Entra ID integration are supported: for those, the user kubeconfig holds
 * the API server address and CA certificate, and no credentials.
 */
export class KubernetesClient {
  private readonly connections = new Map<string, Connection>();

  constructor(
    private readonly http: AzureHttp,
    private readonly arm: ArmClient,
  ) {}

  getCluster(clusterId: string, signal?: AbortSignal): Promise<ManagedCluster> {
    const resource = parseResourceId(clusterId);
    if (resource.type.toLowerCase() !== 'microsoft.containerservice/managedclusters') {
      throw new ToolInputError(
        `${clusterId} is not an AKS cluster (Microsoft.ContainerService/managedClusters).`,
      );
    }
    return this.arm.request<ManagedCluster>({
      method: 'GET',
      path: resource.id,
      apiVersion: AKS_API_VERSION,
      signal,
    });
  }

  async getJson<T>(
    clusterId: string,
    path: string,
    query: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    const connection = await this.connect(clusterId, signal);
    return this.http.json<T>({
      url: buildUrl(connection.server, path, query),
      signal,
      tlsSettings: { ca: connection.ca },
    });
  }

  async getText(
    clusterId: string,
    path: string,
    query: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<string> {
    const connection = await this.connect(clusterId, signal);
    return this.http.text({
      url: buildUrl(connection.server, path, query),
      signal,
      tlsSettings: { ca: connection.ca },
    });
  }

  private async connect(clusterId: string, signal?: AbortSignal): Promise<Connection> {
    const key = clusterId.toLowerCase();
    const cached = this.connections.get(key);
    if (cached !== undefined && cached.expires > Date.now()) return cached;

    const cluster = await this.getCluster(clusterId, signal);
    assertEntraCluster(cluster);

    const credentials = await this.arm
      .request<{ kubeconfigs?: { value?: string }[] }>({
        method: 'POST',
        path: `${parseResourceId(clusterId).id}/listClusterUserCredential`,
        apiVersion: AKS_API_VERSION,
        signal,
      })
      .catch((error: unknown) => {
        if (error instanceof AzureApiError && error.status === 403) {
          throw new KubernetesAccessError(
            `Your account cannot read the connection details of ${cluster.name}. Reading workloads needs the "Azure Kubernetes Service Cluster User Role" on the cluster, plus read access inside it. ${containerInsightsHint(cluster.id)}`,
          );
        }
        throw error;
      });
    const kubeconfig = Buffer.from(credentials.kubeconfigs?.[0]?.value ?? '', 'base64').toString(
      'utf8',
    );
    const connection = { ...parseKubeconfig(kubeconfig), expires: Date.now() + CONNECTION_TTL_MS };
    this.connections.set(key, connection);
    return connection;
  }
}

export function assertEntraCluster(cluster: ManagedCluster): void {
  if (!cluster.properties.aadProfile) {
    throw new KubernetesAccessError(
      `${cluster.name} does not use Entra ID integration, so its Kubernetes API can only be reached with cluster credentials, which this server does not read. ${containerInsightsHint(cluster.id)}`,
    );
  }
}

export function containerInsightsHint(clusterId: string): string {
  return `If Container Insights is enabled, use azure_logs_query with scope ${clusterId} and tables KubePodInventory (pod status), KubeEvents (events) and ContainerLogV2 (container logs).`;
}

/** Extracts the API server and CA certificate from a kubeconfig without a YAML dependency. */
export function parseKubeconfig(kubeconfig: string): { server: string; ca: string } {
  const server = /^\s*server:\s*(\S+)\s*$/m.exec(kubeconfig)?.[1];
  const caData = /^\s*certificate-authority-data:\s*(\S+)\s*$/m.exec(kubeconfig)?.[1];
  if (server === undefined || caData === undefined) {
    throw new KubernetesAccessError(
      'The cluster kubeconfig did not contain an API server address and CA certificate.',
    );
  }
  return { server: server.replace(/\/+$/, ''), ca: Buffer.from(caData, 'base64').toString('utf8') };
}

function buildUrl(server: string, path: string, query: Record<string, string>): string {
  const url = new URL(server + path);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

/** Kubernetes object names (RFC 1123 labels and subdomains). */
export const K8S_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
