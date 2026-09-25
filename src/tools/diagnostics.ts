import { z } from 'zod';
import { ToolInputError } from '../azure/errors.js';
import { parseResourceId } from '../azure/resourceId.js';
import { compact, hoursSchema, isoHoursAgo, resourceIdSchema } from './common.js';
import { defineTool } from './types.js';

/** Resource types with built-in "Diagnose and solve problems" detectors, and their API version. */
const DETECTOR_API: Record<string, string> = {
  'microsoft.web/sites': '2023-12-01',
  'microsoft.web/sites/slots': '2023-12-01',
  'microsoft.app/containerapps': '2024-03-01',
  'microsoft.app/managedenvironments': '2024-03-01',
};

interface DetectorDefinition {
  name?: string;
  properties?: {
    metadata?: {
      id?: string;
      name?: string;
      description?: string;
      category?: string;
      type?: string;
    };
  };
}

interface DetectorResponse {
  properties?: {
    metadata?: { name?: string; description?: string };
    status?: { statusId?: number | string; message?: string };
    dataset?: {
      table?: { tableName?: string; columns?: { columnName?: string }[]; rows?: unknown[][] };
      renderingProperties?: { title?: string; description?: string; type?: number | string };
    }[];
  };
}

const STATUS: Record<string, string> = {
  '0': 'Critical',
  '1': 'Warning',
  '2': 'Info',
  '3': 'Success',
  '4': 'None',
};

export const diagnosticsTool = defineTool({
  name: 'azure_diagnostics',
  title: 'Built-in diagnostics',
  description: [
    'Runs Azure\'s built-in "Diagnose and solve problems" detectors for App Service, Function apps and Container Apps. These analyze platform data you cannot query yourself: crashes, restarts, HTTP 5xx breakdowns, CPU and memory pressure, SNAT port exhaustion, deployment and container start failures.',
    'Call without detector to list the available detectors, then call again with a detector id.',
  ].join(' '),
  inputSchema: z.object({
    resourceId: resourceIdSchema(
      'Resource ID of an App Service, Function app, slot, Container App or Container Apps environment.',
    ),
    detector: z
      .string()
      .trim()
      .regex(/^[\w.-]{1,128}$/, 'Expected a detector id from the list.')
      .optional()
      .describe('Detector id. Omit to list detectors.'),
    hours: hoursSchema(24, 720),
  }),
  async run(input, ctx) {
    const resource = parseResourceId(input.resourceId);
    const apiVersion = DETECTOR_API[resource.type.toLowerCase()];
    if (apiVersion === undefined) {
      throw new ToolInputError(
        `Built-in detectors are available for App Service, Function apps and Container Apps, not for ${resource.type}.`,
      );
    }

    if (input.detector === undefined) {
      const page = await ctx.arm.list<DetectorDefinition>(
        { path: `${resource.id}/detectors`, apiVersion, signal: ctx.signal },
        500,
      );
      const detectors = page.items
        .map((d) => d.properties?.metadata ?? {})
        .map((m) =>
          compact({
            id: m.id,
            name: m.name,
            category: m.category,
            description: m.description?.slice(0, 160),
          }),
        );
      return {
        untrusted: true,
        summary: `${detectors.length} detectors available for ${resource.name}. Pick one by id and call again.`,
        data: { detectors },
        listKey: 'detectors',
      };
    }

    const isWeb = resource.type.toLowerCase().startsWith('microsoft.web/');
    const response = await ctx.arm.request<DetectorResponse>({
      method: 'GET',
      path: `${resource.id}/detectors/${input.detector}`,
      apiVersion,
      query: isWeb
        ? { startTime: isoHoursAgo(input.hours), endTime: new Date().toISOString() }
        : {},
      signal: ctx.signal,
    });

    const props = response.properties ?? {};
    const status =
      STATUS[String(props.status?.statusId)] ?? String(props.status?.statusId ?? 'Unknown');
    const datasets = (props.dataset ?? [])
      .map((d) => {
        const columns = d.table?.columns?.map((c) => c.columnName ?? '?') ?? [];
        const rows = (d.table?.rows ?? [])
          .slice(0, 25)
          .map((row) => compact(Object.fromEntries(columns.map((c, i) => [c, row[i]]))));
        return compact({
          title: d.renderingProperties?.title,
          description: d.renderingProperties?.description,
          rows,
        });
      })
      .filter((d) => d.rows?.length || d.title);

    return {
      untrusted: true,
      summary: `Detector "${props.metadata?.name ?? input.detector}" on ${resource.name}: ${status}${props.status?.message ? ` - ${props.status.message}` : ''}.`,
      data: { detector: input.detector, status, datasets },
      listKey: 'datasets',
    };
  },
});
