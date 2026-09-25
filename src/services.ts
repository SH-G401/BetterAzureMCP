import type { HttpClient } from '@azure/core-rest-pipeline';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import {
  createCredentialChain,
  CredentialManager,
  type NamedCredential,
} from './auth/credentials.js';
import { ApiVersionResolver } from './azure/apiVersions.js';
import { ArmClient } from './azure/armClient.js';
import { AzureHttp } from './azure/http.js';
import { KubernetesClient } from './azure/kubernetes.js';
import { LogAnalyticsClient } from './azure/logAnalytics.js';
import { createHttpStack } from './http/pipeline.js';
import type { AzureServices } from './tools/types.js';

export interface ServiceOverrides {
  /** Replaces the credential chain. Used by tests. */
  credentials?: readonly NamedCredential[];
  /** Replaces the network layer. Used by tests. */
  httpClient?: HttpClient;
}

export function createAzureServices(
  config: Config,
  logger: Logger,
  overrides: ServiceOverrides = {},
): AzureServices {
  const credentials = new CredentialManager(
    overrides.credentials ?? createCredentialChain(config),
    logger,
  );
  const http = new AzureHttp(createHttpStack(credentials, overrides.httpClient));
  const arm = new ArmClient(http);
  return {
    config,
    credentials,
    http,
    arm,
    apiVersions: new ApiVersionResolver(arm),
    logs: new LogAnalyticsClient(http, arm),
    kubernetes: new KubernetesClient(http, arm),
  };
}
