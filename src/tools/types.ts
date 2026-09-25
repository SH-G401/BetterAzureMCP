import type { z } from 'zod';
import type { Config } from '../config.js';
import type { CredentialManager } from '../auth/credentials.js';
import type { ArmClient } from '../azure/armClient.js';
import type { AzureHttp } from '../azure/http.js';
import type { KubernetesClient } from '../azure/kubernetes.js';
import type { LogAnalyticsClient } from '../azure/logAnalytics.js';
import type { ApiVersionResolver } from '../azure/apiVersions.js';
import type { ToolOutput } from '../format/result.js';

/** Everything a tool may use. Tools only reach the network through `http` and `arm`. */
export interface AzureServices {
  config: Config;
  credentials: CredentialManager;
  /** Guarded HTTP for non-ARM endpoints (Log Analytics, Kudu, Kubernetes). */
  http: AzureHttp;
  arm: ArmClient;
  apiVersions: ApiVersionResolver;
  logs: LogAnalyticsClient;
  kubernetes: KubernetesClient;
}

export interface ToolContext extends AzureServices {
  /** Aborted when the client cancels or the tool deadline passes. */
  signal: AbortSignal;
}

export interface ToolDefinition<Schema extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  run(input: z.infer<Schema>, context: ToolContext): Promise<ToolOutput>;
}

export function defineTool<Schema extends z.ZodObject>(
  tool: ToolDefinition<Schema>,
): ToolDefinition<Schema> {
  return tool;
}
