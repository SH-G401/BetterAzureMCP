import type { z } from 'zod';
import type { Config } from '../config.js';
import type { CredentialManager } from '../auth/credentials.js';
import type { ArmClient } from '../azure/armClient.js';
import type { ApiVersionResolver } from '../azure/apiVersions.js';
import type { ToolOutput } from '../format/result.js';

/** Everything a tool may use. Tools never talk to the network except through `arm`. */
export interface AzureServices {
  config: Config;
  credentials: CredentialManager;
  arm: ArmClient;
  apiVersions: ApiVersionResolver;
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
