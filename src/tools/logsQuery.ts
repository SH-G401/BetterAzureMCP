import { z } from 'zod';
import { hoursSchema, limitSchema, plural, resourceIdSchema } from './common.js';
import { defineTool } from './types.js';

export const logsQueryTool = defineTool({
  name: 'azure_logs_query',
  title: 'Query logs (KQL)',
  description: [
    'Runs a KQL query against Azure Monitor Logs.',
    "scope can be a Log Analytics workspace (queries the whole workspace), an Application Insights resource, or any other resource (only that resource's logs, from every workspace it sends to).",
    'Application Insights tables: AppRequests, AppDependencies, AppExceptions, AppTraces. App Service: AppServiceHTTPLogs, AppServiceConsoleLogs. AKS: ContainerLogV2, KubePodInventory, KubeEvents.',
    'Example: {"scope": "<app insights id>", "query": "AppRequests | where Success == false | summarize count() by ResultCode, Name | top 10 by count_"}.',
    'Use azure_telemetry_locations to find the right scope.',
  ].join(' '),
  inputSchema: z.object({
    scope: resourceIdSchema(
      'Resource ID of a Log Analytics workspace, Application Insights resource, or any resource.',
    ),
    query: z.string().trim().min(1).max(10_000).describe('KQL query.'),
    hours: hoursSchema(24, 2160),
    limit: limitSchema(100, 1000, 'rows'),
  }),
  async run(input, ctx) {
    const result = await ctx.logs.query({
      scope: input.scope,
      query: input.query,
      hours: input.hours,
      maxRows: input.limit,
      serverTimeoutSeconds: Math.floor(ctx.config.timeoutMs / 1000) - 5,
      signal: ctx.signal,
    });

    const more = result.truncated ? ` More rows exist; showing the first ${input.limit}.` : '';
    const warning = result.warning ? ` Warning: ${result.warning}` : '';
    return {
      untrusted: true,
      summary: `${plural(result.rows.length, 'row')} from the last ${input.hours} hours.${more}${warning}`,
      data: { rows: result.rows },
      listKey: 'rows',
    };
  },
});
