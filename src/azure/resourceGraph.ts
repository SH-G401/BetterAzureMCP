import type { ArmClient } from './armClient.js';
import { ToolInputError } from './errors.js';

export interface ResourceGraphQuery {
  query: string;
  subscriptionIds?: string[];
  managementGroupIds?: string[];
  top: number;
  skipToken?: string;
  signal?: AbortSignal;
}

export interface ResourceGraphResult {
  totalRecords: number;
  count: number;
  rows: Record<string, unknown>[];
  /** Pass back as `skipToken` to fetch the next page. */
  skipToken?: string;
  resultTruncated: boolean;
}

interface ResourceGraphResponse {
  totalRecords: number;
  count: number;
  data: Record<string, unknown>[];
  $skipToken?: string;
  resultTruncated: 'true' | 'false';
}

/** Runs a KQL query against Azure Resource Graph. Resource Graph is read-only by design. */
export async function queryResourceGraph(
  arm: ArmClient,
  q: ResourceGraphQuery,
): Promise<ResourceGraphResult> {
  const body: Record<string, unknown> = {
    query: q.query,
    options: {
      $top: q.top,
      resultFormat: 'objectArray',
      ...(q.skipToken ? { $skipToken: q.skipToken } : {}),
    },
  };
  const scoped = scopeSubscriptions(arm.subscriptionScope, q);
  // Without explicit scopes, Resource Graph searches every subscription the caller can read.
  if (scoped.length) body.subscriptions = scoped;
  if (q.managementGroupIds?.length) body.managementGroups = q.managementGroupIds;

  const response = await arm.request<ResourceGraphResponse>({
    method: 'POST',
    path: '/providers/Microsoft.ResourceGraph/resources',
    apiVersion: '2021-03-01',
    body,
    signal: q.signal,
  });

  return {
    totalRecords: response.totalRecords,
    count: response.count,
    rows: response.data,
    skipToken: response.$skipToken,
    resultTruncated: response.resultTruncated === 'true',
  };
}

/** Applies BETTERAZUREMCP_SUBSCRIPTIONS to the subscriptions a query runs against. */
function scopeSubscriptions(
  scope: readonly string[] | undefined,
  q: Pick<ResourceGraphQuery, 'subscriptionIds' | 'managementGroupIds'>,
): string[] {
  const requested = q.subscriptionIds ?? [];
  if (scope === undefined) return requested;
  if (q.managementGroupIds?.length) {
    throw new ToolInputError(
      'Management group queries are not available because BETTERAZUREMCP_SUBSCRIPTIONS limits the server to specific subscriptions.',
    );
  }
  if (requested.length === 0) return [...scope];
  const outside = requested.filter((id) => !scope.includes(id.toLowerCase()));
  if (outside.length > 0) {
    throw new ToolInputError(
      `Subscription ${outside.join(', ')} is outside the subscriptions this server is limited to (BETTERAZUREMCP_SUBSCRIPTIONS).`,
    );
  }
  return requested;
}

/** Quotes a value as a KQL verbatim string literal. */
export function kqlString(value: string): string {
  return `@'${value.replaceAll("'", "''")}'`;
}
