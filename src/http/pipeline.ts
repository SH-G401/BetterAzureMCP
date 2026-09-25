import {
  createDefaultHttpClient,
  createEmptyPipeline,
  decompressResponsePolicy,
  defaultRetryPolicy,
  proxyPolicy,
  type HttpClient,
  type Pipeline,
} from '@azure/core-rest-pipeline';
import { SERVER_NAME, VERSION } from '../version.js';
import {
  bearerTokenPolicy,
  egressPolicy,
  readOnlyPolicy,
  userAgentPolicy,
  type TokenProvider,
} from './policies.js';

export interface HttpStack {
  pipeline: Pipeline;
  client: HttpClient;
}

/**
 * The single HTTP stack used for every Azure call.
 *
 * Order matters: the egress and read-only guards run first, before a token is requested.
 * Redirects are never followed, so the checked URL is the URL that is sent.
 * Proxy settings come from HTTPS_PROXY / NO_PROXY.
 */
export function createHttpStack(tokens: TokenProvider, client?: HttpClient): HttpStack {
  const pipeline = createEmptyPipeline();
  pipeline.addPolicy(egressPolicy);
  pipeline.addPolicy(readOnlyPolicy);
  pipeline.addPolicy(proxyPolicy());
  pipeline.addPolicy(decompressResponsePolicy());
  pipeline.addPolicy(userAgentPolicy(`${SERVER_NAME}/${VERSION}`));
  pipeline.addPolicy(
    defaultRetryPolicy({ maxRetries: 3, retryDelayInMs: 800, maxRetryDelayInMs: 8000 }),
    { phase: 'Retry' },
  );
  pipeline.addPolicy(bearerTokenPolicy(tokens), { phase: 'Sign' });
  return { pipeline, client: client ?? createDefaultHttpClient() };
}
