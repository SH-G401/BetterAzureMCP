import { z } from 'zod';
import { parseResourceId } from '../azure/resourceId.js';
import { kqlString, queryResourceGraph } from '../azure/resourceGraph.js';
import { hoursSchema, limitSchema, plural, resourceIdSchema } from './common.js';
import { defineTool } from './types.js';

export const recentChangesTool = defineTool({
  name: 'azure_recent_changes',
  title: 'Recent resource changes',
  description: [
    'Lists configuration changes to a resource, or to every resource in a resource group or subscription, over the last hours (up to 14 days): what changed, the before and after values, who changed it and through which client.',
    'Use it to answer "what changed before this broke?".',
  ].join(' '),
  inputSchema: z.object({
    scope: resourceIdSchema(
      'Resource ID, resource group ID (/subscriptions/<id>/resourceGroups/<name>) or subscription ID path (/subscriptions/<id>).',
    ),
    hours: hoursSchema(24, 336),
    limit: limitSchema(50, 500, 'changes'),
  }),
  async run(input, ctx) {
    const scope = parseResourceId(input.scope);
    const query = [
      'resourcechanges',
      '| extend time = todatetime(properties.changeAttributes.timestamp), resourceId = tostring(properties.targetResourceId)',
      `| where time > ago(${input.hours}h)`,
      `| where resourceId =~ ${kqlString(scope.id)} or resourceId startswith ${kqlString(`${scope.id}/`)}`,
      '| project time, resourceId, changeType = tostring(properties.changeType), changedBy = tostring(properties.changeAttributes.changedBy), clientType = tostring(properties.changeAttributes.clientType), operation = tostring(properties.changeAttributes.operation), changes = properties.changes',
      '| order by time desc',
    ].join('\n');

    const result = await queryResourceGraph(ctx.arm, {
      query,
      subscriptionIds: scope.subscriptionId ? [scope.subscriptionId] : undefined,
      top: input.limit,
      signal: ctx.signal,
    });

    return {
      summary:
        result.count === 0
          ? `No changes recorded for ${scope.name} in the last ${input.hours} hours.`
          : `${plural(result.totalRecords, 'change')} in the last ${input.hours} hours, newest first.`,
      data: { changes: result.rows },
      listKey: 'changes',
    };
  },
});
