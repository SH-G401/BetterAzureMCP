import { z } from 'zod';
import { requireWorkspace, resolveAppInsights } from '../azure/appInsights.js';
import { kqlString } from '../azure/resourceGraph.js';
import { hoursSchema, resourceIdSchema, searchTextSchema } from './common.js';
import { defineTool, type ToolContext } from './types.js';

const appInsightsIdSchema = resourceIdSchema(
  'Application Insights resource ID, or the ID of an app (App Service, Function app, Container App) linked to one.',
);

export const appInsightsFailuresTool = defineTool({
  name: 'azure_appinsights_failures',
  title: 'Application failures overview',
  description: [
    'One-call triage of an application from Application Insights: request volume and failure rate, the most frequent failed operations, top exceptions, failing dependencies (databases, HTTP calls, queues) and the slowest operations.',
    'Each entry carries a sample operation ID to pass to azure_appinsights_trace for the full end-to-end transaction.',
  ].join(' '),
  inputSchema: z.object({
    appInsightsId: appInsightsIdSchema,
    hours: hoursSchema(24, 720),
    role: searchTextSchema(
      'Only this cloud role (service name), for apps that share one Application Insights resource.',
    ).optional(),
  }),
  async run(input, ctx) {
    const component = await resolveAppInsights(ctx.arm, input.appInsightsId, ctx.signal);
    const workspace = requireWorkspace(component);
    const scope = (table: string) =>
      [
        table,
        `| where TimeGenerated > ago(${input.hours}h)`,
        `| where _ResourceId =~ ${kqlString(component.id)}`,
        ...(input.role ? [`| where AppRoleName =~ ${kqlString(input.role)}`] : []),
      ].join('\n');

    const queries = {
      totals: `${scope('AppRequests')}
| summarize requests = count(), failed = countif(Success == false), p95Ms = percentile(DurationMs, 95)`,
      failedRequests: `${scope('AppRequests')}
| where Success == false
| summarize hits = count(), lastSeen = max(TimeGenerated), sampleOperationId = take_any(OperationId) by OperationName, ResultCode
| top 10 by hits`,
      exceptions: `${scope('AppExceptions')}
| summarize hits = count(), lastSeen = max(TimeGenerated), message = take_any(OuterMessage), sampleOperationId = take_any(OperationId) by ExceptionType, ProblemId
| top 10 by hits`,
      failedDependencies: `${scope('AppDependencies')}
| where Success == false
| summarize hits = count(), lastSeen = max(TimeGenerated), sampleOperationId = take_any(OperationId) by DependencyType, Target, Name, ResultCode
| top 10 by hits`,
      slowestOperations: `${scope('AppRequests')}
| summarize hits = count(), p50Ms = percentile(DurationMs, 50), p95Ms = percentile(DurationMs, 95), maxMs = max(DurationMs) by OperationName
| where hits >= 5
| top 10 by p95Ms`,
    };

    const run = (query: string) => runQuery(ctx, workspace, query, input.hours);
    const [totals, failedRequests, exceptions, failedDependencies, slowestOperations] =
      await Promise.all([
        run(queries.totals),
        run(queries.failedRequests),
        run(queries.exceptions),
        run(queries.failedDependencies),
        run(queries.slowestOperations),
      ]);

    const total = totals[0] ?? {};
    const requests = Number(total.requests ?? 0);
    const failed = Number(total.failed ?? 0);
    const rate = requests > 0 ? ((failed / requests) * 100).toFixed(2) : '0';
    const topFailure = failedRequests[0];
    const topException = exceptions[0];
    const parts = [
      `${component.name}, last ${input.hours}h: ${requests} requests, ${failed} failed (${rate}%).`,
      topFailure
        ? `Top failing operation: ${String(topFailure.OperationName)} ${String(topFailure.ResultCode)} (${String(topFailure.hits)}x).`
        : '',
      topException
        ? `Top exception: ${String(topException.ExceptionType)} (${String(topException.hits)}x).`
        : '',
    ];

    return {
      untrusted: true,
      summary: parts.filter(Boolean).join(' '),
      data: {
        appInsights: component.id,
        totals: total,
        failedRequests,
        exceptions,
        failedDependencies,
        slowestOperations,
      },
    };
  },
});

export const appInsightsTraceTool = defineTool({
  name: 'azure_appinsights_trace',
  title: 'End-to-end transaction',
  description: [
    'Shows everything recorded for one operation ID in Application Insights, in time order: the incoming request, outgoing dependency calls, exceptions with stack details, and log traces, across all services.',
    'Get operation IDs from azure_appinsights_failures (sampleOperationId) or from a log query.',
  ].join(' '),
  inputSchema: z.object({
    appInsightsId: appInsightsIdSchema,
    operationId: z
      .string()
      .trim()
      .regex(
        /^[\w.|-]{1,128}$/,
        'Expected an operation ID such as 4bf92f3577b34da6a3ce929d0e0e4736.',
      )
      .describe('Operation ID (trace ID).'),
    hours: hoursSchema(168, 720),
  }),
  async run(input, ctx) {
    const component = await resolveAppInsights(ctx.arm, input.appInsightsId, ctx.signal);
    const workspace = requireWorkspace(component);
    const query = `union AppRequests, AppDependencies, AppExceptions, AppTraces, AppEvents
| where TimeGenerated > ago(${input.hours}h)
| where OperationId == ${kqlString(input.operationId)}
| extend itemType = replace_string(Type, 'App', '')
| project TimeGenerated, itemType, AppRoleName, Name, OperationName, Success, ResultCode, DurationMs, DependencyType, Target, Data = substring(Data, 0, 500), Message = substring(Message, 0, 1000), SeverityLevel, ExceptionType, OuterMessage, InnermostMessage, Details = substring(tostring(Details), 0, 3000), Id, ParentId
| order by TimeGenerated asc
| take 300`;

    const rows = (await runQuery(ctx, workspace, query, input.hours)).map(dropEmpty);
    const failures = rows.filter((r) => r.Success === false || r.itemType === 'Exceptions').length;
    return {
      untrusted: true,
      summary:
        rows.length === 0
          ? `No telemetry found for operation ${input.operationId} in the last ${input.hours} hours. Sampling may have dropped it; try another sampleOperationId.`
          : `${rows.length} telemetry items for operation ${input.operationId}, ${failures} failed or exceptions, in time order.`,
      data: { items: rows },
      listKey: 'items',
    };
  },
});

async function runQuery(
  ctx: ToolContext,
  workspace: string,
  query: string,
  hours: number,
): Promise<Record<string, unknown>[]> {
  const result = await ctx.logs.query({
    scope: workspace,
    query,
    hours,
    maxRows: 300,
    serverTimeoutSeconds: Math.floor(ctx.config.timeoutMs / 1000) - 5,
    signal: ctx.signal,
  });
  return result.rows;
}

function dropEmpty(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== ''));
}
