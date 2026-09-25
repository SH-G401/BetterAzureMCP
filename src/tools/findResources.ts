import { z } from 'zod';
import { kqlString, queryResourceGraph } from '../azure/resourceGraph.js';
import { defineTool } from './types.js';
import { plural, subscriptionIdsSchema } from './common.js';

const plainText = (what: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(260)
    .refine((v) => !/[\r\n]/.test(v), `${what} must be a single line.`);

export const findResourcesTool = defineTool({
  name: 'azure_find_resources',
  title: 'Find Azure resources',
  description: [
    'Finds Azure resources by name, type, resource group, location or tag, across all your subscriptions at once.',
    'Returns resource IDs you can pass to other tools, plus type, location, SKU and provisioning state.',
    'Example: {"name": "orders-api", "type": "Microsoft.Web/sites"}.',
    'Common types: Microsoft.Web/sites (App Service and Functions), Microsoft.App/containerApps, Microsoft.ContainerService/managedClusters (AKS), Microsoft.Insights/components (Application Insights), Microsoft.OperationalInsights/workspaces (Log Analytics).',
  ].join(' '),
  inputSchema: z.object({
    name: plainText('name').optional().describe('Part of the resource name (case-insensitive).'),
    type: plainText('type')
      .optional()
      .describe('Exact resource type, for example Microsoft.Web/sites.'),
    resourceGroup: plainText('resourceGroup').optional().describe('Exact resource group name.'),
    location: plainText('location').optional().describe('Azure region, for example westeurope.'),
    tags: z
      .record(z.string().max(512), z.string().max(256))
      .optional()
      .describe('Tags that must all match exactly, for example {"env": "prod"}.'),
    subscriptionIds: subscriptionIdsSchema,
    limit: z.number().int().min(1).max(500).default(50).describe('Maximum results (default 50).'),
  }),
  async run(input, ctx) {
    const filters: string[] = [];
    if (input.name) filters.push(`name contains ${kqlString(input.name)}`);
    if (input.type) filters.push(`type =~ ${kqlString(input.type)}`);
    if (input.resourceGroup) filters.push(`resourceGroup =~ ${kqlString(input.resourceGroup)}`);
    if (input.location) filters.push(`location =~ ${kqlString(input.location)}`);
    for (const [key, value] of Object.entries(input.tags ?? {})) {
      filters.push(`tostring(tags[${kqlString(key)}]) == ${kqlString(value)}`);
    }

    const query = [
      'resources',
      ...filters.map((f) => `| where ${f}`),
      '| project id, name, type, resourceGroup, location, subscriptionId, kind, sku = sku.name, provisioningState = tostring(properties.provisioningState), tags',
      '| order by name asc',
    ].join('\n');

    const result = await queryResourceGraph(ctx.arm, {
      query,
      subscriptionIds: input.subscriptionIds,
      top: input.limit,
      signal: ctx.signal,
    });

    const more = result.totalRecords > result.count ? ` of ${result.totalRecords}` : '';
    return {
      untrusted: true,
      summary:
        result.count === 0
          ? 'No matching resources found. Try a shorter name fragment, or check the subscription with azure_context.'
          : `Found ${plural(result.count, 'resource')}${more}.`,
      data: { totalRecords: result.totalRecords, resources: result.rows },
      listKey: 'resources',
    };
  },
});
