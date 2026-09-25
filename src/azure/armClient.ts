import { createHttpHeaders, createPipelineRequest } from '@azure/core-rest-pipeline';
import type { HttpStack } from '../http/pipeline.js';
import { ARM_ENDPOINT } from '../http/endpoints.js';
import { AzureApiError } from './errors.js';

export interface ArmRequest {
  method: 'GET' | 'POST';
  /** Path below https://management.azure.com, starting with '/'. */
  path: string;
  apiVersion: string;
  query?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

export interface Page<T> {
  items: T[];
  /** Set when more results exist than were returned. */
  truncated: boolean;
}

/** Minimal Azure Resource Manager client. All traffic goes through the guarded HTTP stack. */
export class ArmClient {
  constructor(private readonly http: HttpStack) {}

  async request<T>(req: ArmRequest): Promise<T> {
    const url = new URL(ARM_ENDPOINT + req.path);
    for (const [key, value] of Object.entries(req.query ?? {})) url.searchParams.set(key, value);
    url.searchParams.set('api-version', req.apiVersion);
    return this.send<T>(req.method, url.toString(), req.body, req.signal);
  }

  /** Follows `nextLink` until `maxItems` is reached. */
  async list<T>(req: Omit<ArmRequest, 'method' | 'body'>, maxItems: number): Promise<Page<T>> {
    const items: T[] = [];
    let page = await this.request<{ value?: T[]; nextLink?: string }>({ ...req, method: 'GET' });
    for (;;) {
      items.push(...(page.value ?? []));
      if (items.length >= maxItems) {
        return { items: items.slice(0, maxItems), truncated: true };
      }
      if (!page.nextLink) return { items, truncated: false };
      page = await this.send(`GET`, page.nextLink, undefined, req.signal);
    }
  }

  private async send<T>(
    method: string,
    url: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const headers = createHttpHeaders({ Accept: 'application/json' });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const request = createPipelineRequest({
      url,
      method: method as 'GET' | 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      abortSignal: signal,
    });

    const response = await this.http.pipeline.sendRequest(this.http.client, request);
    const text = response.bodyAsText ?? '';
    if (response.status >= 400) {
      throw toApiError(response.status, text, response.headers.get('x-ms-request-id'));
    }
    if (text === '') return undefined as T;
    return JSON.parse(text) as T;
  }
}

function toApiError(status: number, body: string, requestId: string | undefined): AzureApiError {
  let code: string | undefined;
  let message = body.slice(0, 500) || `HTTP ${status}`;
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
    code = parsed.error?.code;
    message = parsed.error?.message ?? message;
  } catch {
    // Not JSON; keep the raw text.
  }
  return new AzureApiError(status, code, message, requestId);
}
