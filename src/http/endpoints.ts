/**
 * The complete list of hosts this server may contact, and what it may do on each.
 * Every outbound request is checked against this list (see policies.ts), and access tokens
 * are only requested for these scopes.
 *
 * Adding a host or a permitted path widens the privacy boundary of the project. It needs a
 * matching update to SECURITY.md and to test/unit/endpoints.test.ts.
 */
export interface AllowedEndpoint {
  readonly id: 'arm' | 'log-analytics' | 'kudu' | 'aks';
  /** Human-readable host pattern, used in docs and `doctor`. */
  readonly hosts: string;
  readonly purpose: string;
  /** OAuth scope used for requests to this host. */
  readonly scope: string;
  matchesHost(host: string): boolean;
  /** True when `method` on `path` (lower-cased, no trailing slash) only reads data. */
  allows(method: string, path: string): boolean;
}

export const ARM_ENDPOINT = 'https://management.azure.com';
export const ARM_SCOPE = 'https://management.azure.com/.default';
export const LOG_ANALYTICS_ENDPOINT = 'https://api.loganalytics.io';
/** The Entra application that represents every AKS API server with Entra ID integration. */
export const AKS_SCOPE = '6dae42f8-4368-4678-94ff-3960e28e3630/.default';

const SEGMENT = '[^/]+';
const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const isGet = (method: string): boolean => method === 'GET' || method === 'HEAD';
const exact = (pattern: string): RegExp => new RegExp(`^${pattern}$`);

/** POST requests to ARM that only read. */
const ARM_READ_POSTS: readonly RegExp[] = [
  // Azure Resource Graph query
  exact('/providers/microsoft\\.resourcegraph/resources'),
  // Kubeconfig for Entra ID clusters. Only requested for clusters that use Entra ID, where it
  // holds the API server address and CA certificate but no credentials (see tools/aks).
  exact(
    `/subscriptions/${SEGMENT}/resourcegroups/${SEGMENT}/providers/microsoft\\.containerservice/managedclusters/${SEGMENT}/listclusterusercredential`,
  ),
];

const LOG_ANALYTICS_QUERIES: readonly RegExp[] = [
  exact(`/v1/workspaces/${GUID}/query`),
  // Resource-centric query: /v1/subscriptions/.../providers/<type>/<name>/query
  exact(`/v1/subscriptions/${SEGMENT}(/${SEGMENT})*/query`),
];

/** Kudu (App Service SCM site): log files only. Never site content or configuration. */
const KUDU_PATHS: readonly RegExp[] = [
  exact('/api/logs/docker'),
  /^\/api\/vfs\/logfiles(\/[^/]+)*$/,
];

/** Kubernetes API: status of pods, events, deployments, nodes and namespaces, and pod logs. */
const KUBERNETES_PATHS: readonly RegExp[] = [
  exact('/api/v1/(pods|events|nodes|namespaces)'),
  exact(`/api/v1/namespaces/${SEGMENT}/(pods|events)`),
  exact(`/api/v1/namespaces/${SEGMENT}/pods/${SEGMENT}(/log)?`),
  exact('/apis/apps/v1/deployments'),
  exact(`/apis/apps/v1/namespaces/${SEGMENT}/deployments`),
];

export const ALLOWED_ENDPOINTS: readonly AllowedEndpoint[] = [
  {
    id: 'arm',
    hosts: 'management.azure.com',
    purpose: 'Azure Resource Manager and Azure Resource Graph',
    scope: ARM_SCOPE,
    matchesHost: (host) => host === 'management.azure.com',
    allows: (method, path) =>
      isGet(method) || (method === 'POST' && ARM_READ_POSTS.some((p) => p.test(path))),
  },
  {
    id: 'log-analytics',
    hosts: 'api.loganalytics.io',
    purpose: 'Log Analytics and Application Insights log queries',
    scope: 'https://api.loganalytics.io/.default',
    matchesHost: (host) => host === 'api.loganalytics.io',
    allows: (method, path) =>
      (method === 'POST' || isGet(method)) && LOG_ANALYTICS_QUERIES.some((p) => p.test(path)),
  },
  {
    id: 'kudu',
    hosts: '*.scm.azurewebsites.net',
    purpose: 'App Service log files',
    scope: ARM_SCOPE,
    matchesHost: (host) => /^[a-z0-9-]+\.scm\.([a-z0-9-]+\.)?azurewebsites\.net$/.test(host),
    allows: (method, path) => isGet(method) && KUDU_PATHS.some((p) => p.test(path)),
  },
  {
    id: 'aks',
    hosts: '*.azmk8s.io',
    purpose: 'AKS Kubernetes API (clusters with Entra ID integration)',
    scope: AKS_SCOPE,
    matchesHost: (host) => /^([a-z0-9-]+\.)+azmk8s\.io$/.test(host),
    allows: (method, path) => isGet(method) && KUBERNETES_PATHS.some((p) => p.test(path)),
  },
];

export function findAllowedEndpoint(url: URL): AllowedEndpoint | undefined {
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  return ALLOWED_ENDPOINTS.find((endpoint) => endpoint.matchesHost(host));
}

/** True when the request only reads data, according to the rules of its endpoint. */
export function isReadOnlyRequest(method: string, url: URL): boolean {
  const endpoint = findAllowedEndpoint(url);
  if (endpoint === undefined) return false;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname).toLowerCase().replace(/\/+$/, '');
  } catch {
    return false; // malformed percent-encoding
  }
  if (path.includes('/../') || path.endsWith('/..')) return false;
  return endpoint.allows(method.toUpperCase(), path);
}
