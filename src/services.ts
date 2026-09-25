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
import { ContextStore, defaultStateFile } from './state/contextStore.js';
import type { AzureServices } from './tools/types.js';

export interface ServiceOverrides {
  /** Replaces the credential chain. Used by tests. */
  credentials?: readonly NamedCredential[];
  /** Replaces the network layer. Used by tests. */
  httpClient?: HttpClient;
  /** Replaces the remembered-context store. Used by tests. */
  context?: ContextStore;
}

export function createAzureServices(
  config: Config,
  logger: Logger,
  overrides: ServiceOverrides = {},
): AzureServices {
  const context =
    overrides.context ??
    new ContextStore(
      config.rememberContext ? defaultStateFile(config.stateDir) : undefined,
      logger,
    );
  const remembered = config.rememberContext ? context.get().tenantId : undefined;
  const tenant =
    config.tenantId !== undefined
      ? { id: config.tenantId, remembered: false }
      : remembered !== undefined
        ? { id: remembered, remembered: true }
        : undefined;
  const credentials = new CredentialManager(
    overrides.credentials ?? ((tenantId) => createCredentialChain(config, tenantId)),
    logger,
    tenant,
    () => {
      context.clear();
    },
  );
  const http = new AzureHttp(
    createHttpStack(credentials, overrides.httpClient, config.subscriptions),
  );
  const arm = new ArmClient(http, config.subscriptions);
  return {
    config,
    context,
    credentials,
    http,
    arm,
    apiVersions: new ApiVersionResolver(arm),
    logs: new LogAnalyticsClient(http, arm),
    kubernetes: new KubernetesClient(http, arm),
  };
}
