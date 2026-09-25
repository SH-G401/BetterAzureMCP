import { ARM_ENDPOINT } from '../http/endpoints.js';
import type { AzureHttp } from './http.js';

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
  constructor(private readonly http: AzureHttp) {}

  request<T>(req: ArmRequest): Promise<T> {
    const url = new URL(ARM_ENDPOINT + req.path);
    for (const [key, value] of Object.entries(req.query ?? {})) url.searchParams.set(key, value);
    url.searchParams.set('api-version', req.apiVersion);
    return this.http.json<T>({
      url: url.toString(),
      method: req.method,
      body: req.body,
      signal: req.signal,
    });
  }

  /** GET that follows `nextLink` until `maxItems` is reached. */
  async list<T>(req: Omit<ArmRequest, 'method' | 'body'>, maxItems: number): Promise<Page<T>> {
    const items: T[] = [];
    let page = await this.request<{ value?: T[]; nextLink?: string }>({ ...req, method: 'GET' });
    for (;;) {
      items.push(...(page.value ?? []));
      if (items.length >= maxItems) {
        return {
          items: items.slice(0, maxItems),
          truncated: items.length > maxItems || !!page.nextLink,
        };
      }
      if (!page.nextLink) return { items, truncated: false };
      page = await this.http.json({ url: page.nextLink, signal: req.signal });
    }
  }
}
