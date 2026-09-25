import { z } from 'zod';
import { parseResourceId } from '../azure/resourceId.js';
import { defineTool } from './types.js';

interface ArmResource {
  id?: string;
  name?: string;
  type?: string;
  location?: string;
  properties?: { provisioningState?: string; state?: string };
}

export const getResourceTool = defineTool({
  name: 'azure_get_resource',
  title: 'Get Azure resource details',
  description: [
    'Returns the full Azure Resource Manager definition of one resource: configuration, SKU, identity, networking and state.',
    'Works for any resource type, including child resources such as deployment slots. Secret values are masked.',
    'Get the resource ID from azure_find_resources.',
  ].join(' '),
  inputSchema: z.object({
    resourceId: z
      .string()
      .min(1)
      .max(1024)
      .describe(
        'Full resource ID, for example /subscriptions/<id>/resourceGroups/<group>/providers/Microsoft.Web/sites/<name>.',
      ),
    apiVersion: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}(-[a-z]+)?$/i, 'Expected an API version such as 2024-04-01.')
      .optional()
      .describe('Optional. By default the newest stable API version is used.'),
  }),
  async run(input, ctx) {
    const resource = parseResourceId(input.resourceId);
    const apiVersion = input.apiVersion ?? (await ctx.apiVersions.resolve(resource, ctx.signal));
    const body = await ctx.arm.request<ArmResource>({
      method: 'GET',
      path: resource.id,
      apiVersion,
      signal: ctx.signal,
    });

    const state = body.properties?.provisioningState ?? body.properties?.state;
    const where = body.location ? ` in ${body.location}` : '';
    return {
      summary: `${body.type ?? resource.type} "${body.name ?? resource.name}"${where}${state ? `, state ${state}` : ''} (API version ${apiVersion}).`,
      data: body,
    };
  },
});
