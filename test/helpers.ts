import {
  createHttpHeaders,
  type HttpClient,
  type PipelineRequest,
  type PipelineResponse,
} from '@azure/core-rest-pipeline';
import type { AccessToken, TokenCredential } from '@azure/core-auth';
import type { Config } from '../src/config.js';
import type { NamedCredential } from '../src/auth/credentials.js';
import { silentLogger } from '../src/logger.js';
import { runTool } from '../src/server.js';
import { createAzureServices } from '../src/services.js';
import type { AzureServices, ToolDefinition } from '../src/tools/types.js';

/** The public tool catalog, in order. Renaming a tool is a breaking change. */
export const TOOL_NAMES = [
  'azure_context',
  'azure_find_resources',
  'azure_resource_graph_query',
  'azure_get_resource',
  'azure_resource_health',
  'azure_recent_changes',
  'azure_activity_log',
  'azure_telemetry_locations',
  'azure_metrics',
  'azure_logs_query',
  'azure_appinsights_failures',
  'azure_appinsights_trace',
  'azure_appservice_overview',
  'azure_appservice_logs',
  'azure_diagnostics',
  'azure_containerapp_overview',
  'azure_containerapp_logs',
  'azure_aks_overview',
  'azure_aks_workloads',
  'azure_aks_pod_logs',
];

export const SUB_ID = '00000000-0000-0000-0000-000000000001';
export const RG_ID = `/subscriptions/${SUB_ID}/resourceGroups/rg`;

/** Runs a tool and returns the text of its result. */
export async function callTool(
  tool: ToolDefinition,
  input: unknown,
  services: AzureServices,
): Promise<{ text: string; isError: boolean }> {
  const result = await runTool(
    tool,
    tool.inputSchema.parse(input),
    services,
    silentLogger,
    new AbortController().signal,
  );
  const first = result.content[0];
  return { text: first?.type === 'text' ? first.text : '', isError: result.isError === true };
}

/** Parses the JSON part of a rendered tool result. */
export function dataOf(text: string): Record<string, unknown> {
  return JSON.parse(text.split('\n\n').at(-1) ?? '{}') as Record<string, unknown>;
}

/** A response for a Log Analytics query returning `rows`. */
export function logRows(rows: Record<string, unknown>[]) {
  const columns = Object.keys(rows[0] ?? {});
  return {
    body: {
      tables: [
        {
          name: 'PrimaryResult',
          columns: columns.map((name) => ({ name, type: 'string' })),
          rows: rows.map((r) => columns.map((c) => r[c])),
        },
      ],
    },
  };
}

export const testConfig: Config = {
  tenantId: undefined,
  credential: 'auto',
  timeoutMs: 5_000,
  maxResponseBytes: 64 * 1024,
  showSecrets: false,
  subscriptions: undefined,
  maxMemoryBytes: 1024 * 1024 * 1024,
  logLevel: 'error',
};

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (request: RecordedRequest) => { status?: number; body?: unknown } | undefined;

/** An in-memory HttpClient: records requests and answers from `handler`. */
export class FakeHttpClient implements HttpClient {
  readonly requests: RecordedRequest[] = [];

  constructor(private readonly handler: Handler = () => undefined) {}

  sendRequest(request: PipelineRequest): Promise<PipelineResponse> {
    const recorded: RecordedRequest = {
      method: request.method,
      url: new URL(request.url),
      headers: request.headers.toJSON(),
      body: typeof request.body === 'string' ? (JSON.parse(request.body) as unknown) : undefined,
    };
    this.requests.push(recorded);
    const reply = this.handler(recorded) ?? {
      status: 404,
      body: { error: { code: 'NotFound', message: 'No fake response.' } },
    };
    return Promise.resolve({
      request,
      status: reply.status ?? 200,
      headers: createHttpHeaders({ 'x-ms-request-id': 'req-123' }),
      bodyAsText:
        reply.body === undefined
          ? ''
          : typeof reply.body === 'string'
            ? reply.body
            : JSON.stringify(reply.body),
    });
  }
}

export function fakeToken(claims: Record<string, unknown> = {}, ttlMs = 3_600_000): AccessToken {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return {
    token: `${encode({ alg: 'none' })}.${encode({ tid: 'tenant-1', upn: 'dev@contoso.com', oid: 'oid-1', ...claims })}.sig`,
    expiresOnTimestamp: Date.now() + ttlMs,
  };
}

export function fakeCredential(
  source: NamedCredential['source'],
  getToken: TokenCredential['getToken'],
): NamedCredential {
  return { source, label: `fake ${source}`, credential: { getToken } };
}

export function servicesWith(handler: Handler, config: Partial<Config> = {}) {
  const http = new FakeHttpClient(handler);
  const services = createAzureServices({ ...testConfig, ...config }, silentLogger, {
    credentials: [fakeCredential('azurecli', () => Promise.resolve(fakeToken()))],
    httpClient: http,
  });
  return { services, http };
}
