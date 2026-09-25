import type { PipelinePolicy } from '@azure/core-rest-pipeline';
import { findAllowedEndpoint, READ_ONLY_POST_PATHS } from './endpoints.js';

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

/** Refuses anything that could change state in Azure. */
export const readOnlyPolicy: PipelinePolicy = {
  name: 'betterazuremcp-read-only',
  sendRequest(request, next) {
    if (!isReadOnlyRequest(request.method, new URL(request.url))) {
      return Promise.reject(
        new PolicyViolationError(
          `Blocked ${request.method} ${new URL(request.url).pathname}: this server is read-only.`,
        ),
      );
    }
    return next(request);
  },
};

export function isReadOnlyRequest(method: string, url: URL): boolean {
  const verb = method.toUpperCase();
  if (verb === 'GET' || verb === 'HEAD') return true;
  if (verb !== 'POST') return false;
  const path = url.pathname.toLowerCase().replace(/\/+$/, '');
  return READ_ONLY_POST_PATHS.some((pattern) => pattern.test(path));
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
