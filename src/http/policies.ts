import type { PipelinePolicy } from '@azure/core-rest-pipeline';
import { findAllowedEndpoint, isReadOnlyRequest } from './endpoints.js';

export class PolicyViolationError extends Error {
  override name = 'PolicyViolationError';
}

/** Refuses any request to a host that is not on the allowlist in endpoints.ts. */
export const egressPolicy: PipelinePolicy = {
  name: 'betterazuremcp-egress',
  sendRequest(request, next) {
    const url = new URL(request.url);
    if (findAllowedEndpoint(url) === undefined) {
      return Promise.reject(
        new PolicyViolationError(`Blocked request to ${url.origin}: host is not on the allowlist.`),
      );
    }
    return next(request);
  },
};

/** Refuses anything that could change state in Azure, and reads outside the permitted paths. */
export const readOnlyPolicy: PipelinePolicy = {
  name: 'betterazuremcp-read-only',
  sendRequest(request, next) {
    if (!isReadOnlyRequest(request.method, new URL(request.url))) {
      return Promise.reject(
        new PolicyViolationError(
          `Blocked ${request.method} ${new URL(request.url).pathname}: this server is read-only and only reads permitted paths.`,
        ),
      );
    }
    return next(request);
  },
};

/**
 * Refuses requests that name a subscription outside the configured allowlist
 * (BETTERAZUREMCP_SUBSCRIPTIONS), and Resource Graph queries that are not limited to it.
 */
export function subscriptionScopePolicy(allowed: readonly string[]): PipelinePolicy {
  const allow = new Set(allowed.map((id) => id.toLowerCase()));
  return {
    name: 'betterazuremcp-subscription-scope',
    sendRequest(request, next) {
      const url = new URL(request.url);
      const blocked = checkSubscriptionScope(url, request.body, allow);
      if (blocked !== undefined) return Promise.reject(new PolicyViolationError(blocked));
      return next(request);
    },
  };
}

export function checkSubscriptionScope(
  url: URL,
  body: unknown,
  allow: ReadonlySet<string>,
): string | undefined {
  let path: string;
  try {
    path = decodeURIComponent(url.pathname).toLowerCase();
  } catch {
    return 'Blocked request with a malformed path.';
  }
  const named = /\/subscriptions\/([^/]+)/.exec(path)?.[1];
  if (named !== undefined && !allow.has(named)) {
    return `Blocked: subscription ${named} is outside BETTERAZUREMCP_SUBSCRIPTIONS.`;
  }
  if (path.replace(/\/+$/, '') === '/providers/microsoft.resourcegraph/resources') {
    let query: { subscriptions?: unknown; managementGroups?: unknown } = {};
    try {
      query = JSON.parse(typeof body === 'string' ? body : '{}') as typeof query;
    } catch {
      return 'Blocked: unreadable Resource Graph query.';
    }
    const subs = Array.isArray(query.subscriptions) ? (query.subscriptions as unknown[]) : [];
    if (query.managementGroups !== undefined || subs.length === 0) {
      return 'Blocked: Resource Graph queries must be limited to BETTERAZUREMCP_SUBSCRIPTIONS.';
    }
    const outside = subs.filter((s) => typeof s !== 'string' || !allow.has(s.toLowerCase()));
    if (outside.length > 0) {
      return `Blocked: subscription ${String(outside[0])} is outside BETTERAZUREMCP_SUBSCRIPTIONS.`;
    }
  }
  return undefined;
}

export interface TokenProvider {
  getToken(scope: string, signal?: AbortSignal): Promise<string>;
}

/** Adds a bearer token for the scope that belongs to the request's host. */
export function bearerTokenPolicy(tokens: TokenProvider): PipelinePolicy {
  return {
    name: 'betterazuremcp-bearer-token',
    async sendRequest(request, next) {
      const endpoint = findAllowedEndpoint(new URL(request.url));
      if (endpoint === undefined) {
        throw new PolicyViolationError(`No token scope for ${new URL(request.url).origin}.`);
      }
      const signal = request.abortSignal as AbortSignal | undefined;
      const token = await tokens.getToken(endpoint.scope, signal);
      request.headers.set('Authorization', `Bearer ${token}`);
      return next(request);
    },
  };
}

/** Sends a fixed, minimal User-Agent instead of the SDK default (which includes OS details). */
export function userAgentPolicy(userAgent: string): PipelinePolicy {
  return {
    name: 'betterazuremcp-user-agent',
    sendRequest(request, next) {
      request.headers.set('User-Agent', userAgent);
      return next(request);
    },
  };
}
