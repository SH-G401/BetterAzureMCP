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
import { createAzureServices } from '../src/services.js';

export const testConfig: Config = {
  tenantId: undefined,
  credential: 'auto',
  timeoutMs: 5_000,
  maxResponseBytes: 64 * 1024,
  showSecrets: false,
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
      bodyAsText: reply.body === undefined ? '' : JSON.stringify(reply.body),
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
