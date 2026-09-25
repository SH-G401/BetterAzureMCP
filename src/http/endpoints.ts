/**
 * The complete list of hosts this server may contact. Every outbound request is checked
 * against it (see `egressPolicy`), and access tokens are only requested for these scopes.
 *
 * Adding a host here widens the privacy boundary of the project. It needs a matching update
 * to SECURITY.md and to test/unit/endpoints.test.ts.
 */
export interface AllowedEndpoint {
  readonly host: string;
  /** OAuth scope used for requests to this host. */
  readonly scope: string;
  readonly purpose: string;
}

export const ALLOWED_ENDPOINTS: readonly AllowedEndpoint[] = [
  {
    host: 'management.azure.com',
    scope: 'https://management.azure.com/.default',
    purpose: 'Azure Resource Manager and Azure Resource Graph (read-only)',
  },
];

export const ARM_ENDPOINT = 'https://management.azure.com';
export const ARM_SCOPE = 'https://management.azure.com/.default';

export function findAllowedEndpoint(url: URL): AllowedEndpoint | undefined {
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  return ALLOWED_ENDPOINTS.find((endpoint) => endpoint.host === host);
}

/**
 * POST requests that are reads in disguise. Anything else that is not GET/HEAD is refused.
 * Matched against the lower-cased URL path.
 */
export const READ_ONLY_POST_PATHS: readonly RegExp[] = [
  // Azure Resource Graph query
  /^\/providers\/microsoft\.resourcegraph\/resources$/,
];
