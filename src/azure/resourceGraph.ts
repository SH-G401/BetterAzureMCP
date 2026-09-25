import type { ArmClient } from './armClient.js';

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
  // Without explicit scopes, Resource Graph searches every subscription the caller can read.
  if (q.subscriptionIds?.length) body.subscriptions = q.subscriptionIds;
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

/** Quotes a value as a KQL verbatim string literal. */
export function kqlString(value: string): string {
  return `@'${value.replaceAll("'", "''")}'`;
}
