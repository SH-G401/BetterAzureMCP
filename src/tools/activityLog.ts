import { z } from 'zod';
import { parseResourceId } from '../azure/resourceId.js';
import {
  compact,
  hoursSchema,
  isoHoursAgo,
  limitSchema,
  plural,
  resourceIdSchema,
} from './common.js';
import { defineTool } from './types.js';

interface ActivityLogEvent {
  eventTimestamp?: string;
  operationName?: { localizedValue?: string; value?: string };
  status?: { value?: string };
  subStatus?: { localizedValue?: string };
  caller?: string;
  resourceId?: string;
  level?: string;
  category?: { value?: string };
  correlationId?: string;
  properties?: { statusMessage?: string; [key: string]: unknown };
}

export const activityLogTool = defineTool({
  name: 'azure_activity_log',
  title: 'Activity log',
  description: [
    'Lists control-plane operations from the Azure activity log: deployments, restarts, scaling, configuration updates, role assignments, and their failures, with the caller and error message.',
    'Scope it to a resource, a resource group or a whole subscription. Set onlyFailures to see only failed operations.',
  ].join(' '),
  inputSchema: z.object({
    scope: resourceIdSchema(
      'Resource ID, resource group ID (/subscriptions/<id>/resourceGroups/<name>) or subscription ID path (/subscriptions/<id>).',
    ),
    hours: hoursSchema(24, 2160),
    onlyFailures: z.boolean().default(false).describe('Only return failed operations and errors.'),
    limit: limitSchema(50, 200, 'events'),
  }),
  async run(input, ctx) {
    const scope = parseResourceId(input.scope);
    const filters = [
      `eventTimestamp ge '${isoHoursAgo(input.hours)}'`,
      `eventTimestamp le '${new Date().toISOString()}'`,
    ];
    if (scope.type === 'Microsoft.Resources/resourceGroups') {
      filters.push(`resourceGroupName eq '${odata(scope.name)}'`);
    } else if (scope.type !== 'Microsoft.Resources/subscriptions') {
      filters.push(`resourceUri eq '${odata(scope.id)}'`);
    }

    const page = await ctx.arm.list<ActivityLogEvent>(
      {
        path: `/subscriptions/${scope.subscriptionId ?? ''}/providers/Microsoft.Insights/eventtypes/management/values`,
        apiVersion: '2015-04-01',
        query: {
          $filter: filters.join(' and '),
          $select:
            'eventTimestamp,operationName,status,subStatus,caller,resourceId,level,category,correlationId,properties',
        },
        signal: ctx.signal,
      },
      input.onlyFailures ? 1000 : input.limit,
    );

    const failed = (e: ActivityLogEvent) =>
      e.status?.value === 'Failed' || e.level === 'Error' || e.level === 'Critical';
    const events = page.items
      .filter((e) => !input.onlyFailures || failed(e))
      .slice(0, input.limit)
      .map((e) =>
        compact({
          time: e.eventTimestamp,
          operation: e.operationName?.localizedValue ?? e.operationName?.value,
          status: e.status?.value,
          subStatus: e.subStatus?.localizedValue || undefined,
          level: e.level,
          caller: e.caller,
          resourceId: e.resourceId,
          category: e.category?.value,
          correlationId: e.correlationId,
          error: statusMessage(e.properties?.statusMessage),
        }),
      );

    const failures = page.items.filter(failed).length;
    return {
      summary:
        events.length === 0
          ? `No ${input.onlyFailures ? 'failed operations' : 'activity'} for ${scope.name} in the last ${input.hours} hours.`
          : `${plural(events.length, 'event')} for ${scope.name} in the last ${input.hours} hours, newest first (${failures} failed in the scanned set).`,
      data: { events },
      listKey: 'events',
    };
  },
});

function odata(value: string): string {
  return value.replaceAll("'", "''");
}

/** The status message is often a JSON string holding an ARM error. */
function statusMessage(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as {
      error?: { code?: string; message?: string };
      message?: string;
      Message?: string;
    };
    const error = parsed.error;
    if (error?.message) return error.code ? `${error.code}: ${error.message}` : error.message;
    return parsed.message ?? parsed.Message ?? raw.slice(0, 500);
  } catch {
    return raw.slice(0, 500);
  }
}
