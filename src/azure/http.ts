import {
  createHttpHeaders,
  createPipelineRequest,
  type TlsSettings,
} from '@azure/core-rest-pipeline';
import type { HttpStack } from '../http/pipeline.js';
import { AzureApiError } from './errors.js';

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Extra trusted CA certificates, for example an AKS cluster CA. */
  tlsSettings?: TlsSettings;
}

export interface HttpResult {
  status: number;
  text: string;
  headers: { get(name: string): string | undefined };
}

/** Sends requests through the guarded HTTP stack and turns error responses into AzureApiError. */
export class AzureHttp {
  constructor(private readonly stack: HttpStack) {}

  async json<T>(req: HttpRequest): Promise<T> {
    const { text } = await this.send({
      ...req,
      headers: { Accept: 'application/json', ...req.headers },
    });
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }

  async text(req: HttpRequest): Promise<string> {
    return (await this.send(req)).text;
  }

  async send(req: HttpRequest): Promise<HttpResult> {
    const headers = createHttpHeaders(req.headers);
    if (req.body !== undefined) headers.set('Content-Type', 'application/json');
    const request = createPipelineRequest({
      url: req.url,
      method: req.method ?? 'GET',
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      abortSignal: req.signal,
      tlsSettings: req.tlsSettings,
    });

    const response = await this.stack.pipeline.sendRequest(this.stack.client, request);
    const text = response.bodyAsText ?? '';
    if (response.status >= 400) {
      throw toApiError(
        response.status,
        text,
        response.headers.get('x-ms-request-id') ?? response.headers.get('request-id'),
      );
    }
    return { status: response.status, text, headers: response.headers };
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; innererror?: { message?: string } };
  // Kubernetes Status object
  reason?: string;
  message?: string;
  Message?: string;
}

export function toApiError(
  status: number,
  body: string,
  requestId: string | undefined,
): AzureApiError {
  let code: string | undefined;
  let message = body.trim().slice(0, 500) || `HTTP ${status}`;
  try {
    const parsed = JSON.parse(body) as ErrorBody;
    code = parsed.error?.code ?? parsed.reason;
    const inner = parsed.error?.innererror?.message;
    const outer = parsed.error?.message ?? parsed.message ?? parsed.Message;
    if (outer !== undefined) message = inner && inner !== outer ? `${outer} ${inner}` : outer;
  } catch {
    // Not JSON; keep the raw text.
  }
  return new AzureApiError(status, code, message, requestId);
}
