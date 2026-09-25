import { LOG_ANALYTICS_ENDPOINT } from '../http/endpoints.js';
import type { ArmClient } from './armClient.js';
import type { AzureHttp } from './http.js';
import { parseResourceId } from './resourceId.js';
import { AzureApiError } from './errors.js';

export interface LogQuery {
  /** Resource ID of a Log Analytics workspace, or of any resource for a resource-centric query. */
  scope: string;
  query: string;
  hours: number;
  /** At most this many rows are returned. The query is capped server-side as well. */
  maxRows: number;
  signal?: AbortSignal;
  /** Seconds the service may spend on the query. */
  serverTimeoutSeconds?: number;
}

export interface LogQueryResult {
  rows: Record<string, unknown>[];
  /** True when the query produced more rows than `maxRows`. */
  truncated: boolean;
  /** Set when the service returned partial results with a warning. */
  warning?: string;
}

interface QueryResponse {
  tables?: { name: string; columns: { name: string }[]; rows: unknown[][] }[];
  error?: { message?: string; details?: { message?: string }[] };
}

/** Runs KQL queries through the Log Analytics query API (api.loganalytics.io). */
export class LogAnalyticsClient {
  private readonly workspaceIds = new Map<string, Promise<string>>();

  constructor(
    private readonly http: AzureHttp,
    private readonly arm: ArmClient,
  ) {}

  async query(q: LogQuery): Promise<LogQueryResult> {
    const path = await this.queryPath(q.scope, q.signal);
    const wait = Math.max(5, Math.min(q.serverTimeoutSeconds ?? 50, 600));
    const response = await this.http.json<QueryResponse>({
      url: `${LOG_ANALYTICS_ENDPOINT}${path}`,
      method: 'POST',
      body: { query: capRows(q.query, q.maxRows + 1), timespan: `PT${q.hours}H` },
      headers: { Prefer: `wait=${wait}` },
      signal: q.signal,
    });

    const table = response.tables?.[0];
    const rows = (table?.rows ?? []).map((row) => {
      const record: Record<string, unknown> = {};
      table?.columns.forEach((column, i) => (record[column.name] = row[i]));
      return record;
    });
    const warning = response.error?.details?.[0]?.message ?? response.error?.message ?? undefined;
    return {
      rows: rows.slice(0, q.maxRows),
      truncated: rows.length > q.maxRows,
      ...(warning ? { warning } : {}),
    };
  }

  /** Workspaces are queried by their workspace (customer) ID; other resources by resource ID. */
  private async queryPath(scope: string, signal?: AbortSignal): Promise<string> {
    const resource = parseResourceId(scope);
    if (resource.type.toLowerCase() === 'microsoft.operationalinsights/workspaces') {
      return `/v1/workspaces/${await this.workspaceId(resource.id, signal)}/query`;
    }
    return `/v1${resource.id}/query`;
  }

  private workspaceId(resourceId: string, signal?: AbortSignal): Promise<string> {
    const key = resourceId.toLowerCase();
    let entry = this.workspaceIds.get(key);
    if (entry === undefined) {
      entry = this.arm
        .request<{ properties?: { customerId?: string } }>({
          method: 'GET',
          path: resourceId,
          apiVersion: '2022-10-01',
          signal,
        })
        .then((workspace) => {
          const id = workspace.properties?.customerId;
          if (!id)
            throw new AzureApiError(
              404,
              'WorkspaceIdMissing',
              'Workspace has no workspace ID.',
              undefined,
            );
          return id;
        });
      entry.catch(() => this.workspaceIds.delete(key));
      this.workspaceIds.set(key, entry);
    }
    return entry;
  }
}

/**
 * Appends a row cap to a KQL query so a broad query cannot return millions of rows.
 * The cap applies to the query's final tabular expression.
 */
export function capRows(query: string, rows: number): string {
  const trimmed = query.trim().replace(/;+$/, '').trimEnd();
  return `${trimmed}\n| take ${rows}`;
}
