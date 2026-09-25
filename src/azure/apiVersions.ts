import type { ArmClient } from './armClient.js';
import type { ParsedResourceId } from './resourceId.js';
import { ToolInputError } from './errors.js';

interface ProviderInfo {
  resourceTypes?: { resourceType: string; apiVersions?: string[] }[];
}

const FIXED_VERSIONS: Record<string, string> = {
  'microsoft.resources/subscriptions': '2022-12-01',
  'microsoft.resources/resourcegroups': '2021-04-01',
};

/**
 * Picks an API version for a resource type from the provider's own metadata: the newest
 * stable version, or the newest preview when no stable version exists. Cached per provider.
 */
export class ApiVersionResolver {
  private readonly cache = new Map<string, Promise<ProviderInfo>>();

  constructor(private readonly arm: ArmClient) {}

  async resolve(resource: ParsedResourceId, signal?: AbortSignal): Promise<string> {
    const fixed = FIXED_VERSIONS[resource.type.toLowerCase()];
    if (fixed !== undefined) return fixed;
    if (resource.provider === undefined) {
      throw new ToolInputError(`Cannot determine the resource provider for ${resource.id}.`);
    }

    return this.resolveType(
      resource.provider,
      resource.type.slice(resource.provider.length + 1),
      signal,
    );
  }

  /** API version for `resourceType` (e.g. `sites/slots`) of `provider` (e.g. `Microsoft.Web`). */
  async resolveType(provider: string, resourceType: string, signal?: AbortSignal): Promise<string> {
    const info = await this.providerInfo(provider, signal);
    const wanted = resourceType.toLowerCase();
    const match = info.resourceTypes?.find((t) => t.resourceType.toLowerCase() === wanted);
    const version = pickApiVersion(match?.apiVersions ?? []);
    if (version === undefined) {
      throw new ToolInputError(
        `No API version found for ${provider}/${resourceType}. Pass apiVersion explicitly.`,
      );
    }
    return version;
  }

  private providerInfo(provider: string, signal?: AbortSignal): Promise<ProviderInfo> {
    const key = provider.toLowerCase();
    let entry = this.cache.get(key);
    if (entry === undefined) {
      entry = this.arm.request<ProviderInfo>({
        method: 'GET',
        path: `/providers/${encodeURIComponent(provider)}`,
        apiVersion: '2021-04-01',
        signal,
      });
      // Do not cache failures.
      entry.catch(() => this.cache.delete(key));
      this.cache.set(key, entry);
    }
    return entry;
  }
}

export function pickApiVersion(versions: readonly string[]): string | undefined {
  const sorted = [...versions].sort().reverse();
  return sorted.find((v) => !v.toLowerCase().includes('preview')) ?? sorted[0];
}
