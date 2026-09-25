import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { Logger } from './logger.js';
import { describeError, ToolTimeoutError } from './azure/errors.js';
import { renderError, renderToolOutput } from './format/result.js';
import { TOOLS } from './tools/index.js';
import type { AzureServices, ToolDefinition } from './tools/types.js';
import { SERVER_NAME, VERSION } from './version.js';

const INSTRUCTIONS = `Read-only access to the user's Azure environment, for debugging applications. Nothing can be created, changed or deleted through this server.

Typical flow when something is broken:
1. azure_find_resources to get the resource ID.
2. azure_resource_health, azure_recent_changes and azure_activity_log to rule out platform issues, configuration changes and failed deployments.
3. azure_telemetry_locations to find where logs go, then azure_appinsights_failures, azure_appinsights_trace or azure_logs_query.
4. Platform tools for App Service (azure_appservice_*), Container Apps (azure_containerapp_*), AKS (azure_aks_*) and azure_diagnostics for Azure's built-in detectors. azure_metrics for CPU, memory, errors and latency.

Use azure_context for subscription IDs or when a sign-in or permission error occurs. Tool errors explain what to do next; pass those instructions on to the user when they require action (for example "az login" or a missing role).`;

export function createMcpServer(services: AzureServices, logger: Logger): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  for (const tool of TOOLS) registerTool(server, tool, services, logger);
  return server;
}

function registerTool(
  server: McpServer,
  tool: ToolDefinition,
  services: AzureServices,
  logger: Logger,
): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        title: tool.title,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (input, ctx) => runTool(tool, input, services, logger, ctx.mcpReq.signal),
  );
}

/** Runs a tool with a hard deadline. Never throws: every failure becomes an error result. */
export async function runTool<Schema extends z.ZodObject>(
  tool: ToolDefinition<Schema>,
  input: z.infer<Schema>,
  services: AzureServices,
  logger: Logger,
  clientSignal: AbortSignal,
): Promise<CallToolResult> {
  const { timeoutMs, maxResponseBytes, showSecrets } = services.config;
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(
      new ToolTimeoutError(
        `${tool.name} did not finish within ${timeoutMs / 1000} seconds and was stopped. Try a narrower request. The limit can be raised with BETTERAZUREMCP_TIMEOUT_SECONDS.`,
      ),
    );
  }, timeoutMs);
  const signal = AbortSignal.any([clientSignal, deadline.signal]);
  const started = Date.now();

  try {
    const work = tool.run(input, { ...services, signal });
    // If the deadline wins the race, a late failure of `work` must not become unhandled.
    work.catch(() => undefined);
    // Resolve on abort even if a dependency ignores the signal.
    const output = await Promise.race([work, rejectOnAbort(signal)]);
    logger.debug(`${tool.name} finished in ${Date.now() - started} ms`);
    return renderToolOutput(output, { maxBytes: maxResponseBytes, showSecrets });
  } catch (error) {
    const reason = signal.aborted ? (signal.reason as unknown) : error;
    logger.warn(
      `${tool.name} failed after ${Date.now() - started} ms: ${describeError(reason).split('\n')[0] ?? ''}`,
    );
    return renderError(describeError(reason));
  } finally {
    clearTimeout(timer);
  }
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted.'));
    };
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}
