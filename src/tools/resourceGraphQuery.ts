import { z } from 'zod';
import { queryResourceGraph } from '../azure/resourceGraph.js';
import { defineTool } from './types.js';
import { plural, subscriptionIdsSchema } from './common.js';

export const resourceGraphQueryTool = defineTool({
  name: 'azure_resource_graph_query',
  title: 'Query Azure Resource Graph',
  description: [
    'Runs a KQL query against Azure Resource Graph: a fast, read-only index of every resource across your subscriptions.',
    'Useful tables: resources, resourcecontainers (subscriptions and resource groups), resourcechanges (recent property changes), healthresources (availability), advisorresources, policyresources.',
    'Examples:',
    '"resources | where type =~ \'microsoft.web/sites\' | summarize count() by location";',
    '"resourcechanges | where properties.changeAttributes.timestamp > ago(1d) | project properties.targetResourceId, properties.changeType, properties.changes | take 20".',
    'Use azure_find_resources for simple lookups.',
  ].join(' '),
  inputSchema: z.object({
    query: z.string().trim().min(1).max(10_000).describe('KQL query.'),
    subscriptionIds: subscriptionIdsSchema,
    managementGroupIds: z
      .array(z.string().min(1).max(90))
      .max(10)
      .optional()
      .describe('Management group IDs to query instead of subscriptions.'),
    top: z.number().int().min(1).max(1000).default(100).describe('Maximum rows (default 100).'),
    skipToken: z
      .string()
      .max(4096)
      .optional()
      .describe('Continuation token from a previous call, to fetch the next page.'),
  }),
  async run(input, ctx) {
    const result = await queryResourceGraph(ctx.arm, {
      query: input.query,
      subscriptionIds: input.subscriptionIds,
      managementGroupIds: input.managementGroupIds,
      top: input.top,
      skipToken: input.skipToken,
      signal: ctx.signal,
    });

    const paging = result.skipToken ? ' More rows are available: pass skipToken to continue.' : '';
    return {
      untrusted: true,
      summary: `Returned ${plural(result.count, 'row')} (total ${result.totalRecords}).${paging}`,
      data: {
        totalRecords: result.totalRecords,
        skipToken: result.skipToken,
        rows: result.rows,
      },
      listKey: 'rows',
    };
  },
});
