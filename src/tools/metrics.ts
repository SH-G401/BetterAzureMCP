import { z } from 'zod';
import { ToolInputError } from '../azure/errors.js';
import { parseResourceId } from '../azure/resourceId.js';
import { compact, hoursSchema, isoHoursAgo, resourceIdSchema, searchTextSchema } from './common.js';
import { defineTool } from './types.js';

const AGGREGATIONS = ['Average', 'Minimum', 'Maximum', 'Total', 'Count'] as const;
type Aggregation = (typeof AGGREGATIONS)[number];

interface MetricDefinition {
  name?: { value?: string };
  namespace?: string;
  unit?: string;
  primaryAggregationType?: string;
  dimensions?: { value?: string }[];
}

interface MetricsResponse {
  value?: {
    name?: { value?: string };
    unit?: string;
    timeseries?: {
      metadatavalues?: { name?: { value?: string }; value?: string }[];
      data?: Record<string, number | string | undefined>[];
    }[];
  }[];
}

const MAX_POINTS = 30;

export const metricsTool = defineTool({
  name: 'azure_metrics',
  title: 'Azure Monitor metrics',
  description: [
    'Reads platform metrics for any resource: CPU, memory, requests, HTTP 5xx, response time, restarts, queue length, DTU and so on.',
    'Call without metrics to list the metrics a resource offers. With metrics, returns min/avg/max/latest per series and a downsampled time series.',
    'Example: {"resourceId": "...sites/orders-api", "metrics": ["Http5xx", "HttpResponseTime"], "hours": 6}. Split by a dimension with filter, e.g. "Instance eq \'*\'".',
  ].join(' '),
  inputSchema: z.object({
    resourceId: resourceIdSchema('Resource ID.'),
    metrics: z
      .array(z.string().min(1).max(200))
      .max(20)
      .optional()
      .describe('Metric names. Omit to list available metrics.'),
    hours: hoursSchema(1, 720),
    aggregation: z
      .enum(AGGREGATIONS)
      .optional()
      .describe("Aggregation. Default: each metric's primary aggregation."),
    interval: z
      .enum(['PT1M', 'PT5M', 'PT15M', 'PT30M', 'PT1H', 'PT6H', 'PT12H', 'P1D'])
      .optional()
      .describe('Time grain. Chosen automatically from the time range if omitted.'),
    filter: searchTextSchema(
      'Dimension filter, e.g. "StatusCode eq \'500\'" or "Instance eq \'*\'" to split by instance.',
    ).optional(),
  }),
  async run(input, ctx) {
    const resource = parseResourceId(input.resourceId);
    const definitions = await ctx.arm.list<MetricDefinition>(
      {
        path: `${resource.id}/providers/Microsoft.Insights/metricDefinitions`,
        apiVersion: '2018-01-01',
        signal: ctx.signal,
      },
      1000,
    );

    if (!input.metrics?.length) {
      return {
        summary: `${resource.name} offers ${definitions.items.length} metrics. Call again with the metric names you need.`,
        data: {
          metrics: definitions.items.map((d) =>
            compact({
              name: d.name?.value,
              unit: d.unit,
              aggregation: d.primaryAggregationType,
              dimensions: d.dimensions?.map((x) => x.value),
            }),
          ),
        },
        listKey: 'metrics',
      };
    }

    const byName = new Map(definitions.items.map((d) => [d.name?.value?.toLowerCase() ?? '', d]));
    const unknown = input.metrics.filter((m) => !byName.has(m.toLowerCase()));
    if (unknown.length > 0) {
      throw new ToolInputError(
        `Unknown metric(s) for ${resource.name}: ${unknown.join(', ')}. Available: ${definitions.items
          .map((d) => d.name?.value)
          .slice(0, 60)
          .join(', ')}.`,
      );
    }

    // One request per metric namespace and aggregation.
    const groups = new Map<
      string,
      { namespace?: string; aggregation: Aggregation; names: string[] }
    >();
    for (const name of input.metrics) {
      const def = byName.get(name.toLowerCase());
      const aggregation = input.aggregation ?? toAggregation(def?.primaryAggregationType);
      const key = `${def?.namespace ?? ''}|${aggregation}`;
      const group = groups.get(key) ?? { namespace: def?.namespace, aggregation, names: [] };
      group.names.push(def?.name?.value ?? name);
      groups.set(key, group);
    }

    const interval = input.interval ?? autoInterval(input.hours);
    const responses = await Promise.all(
      [...groups.values()].map(async (group) => ({
        group,
        response: await ctx.arm.request<MetricsResponse>({
          method: 'GET',
          path: `${resource.id}/providers/Microsoft.Insights/metrics`,
          apiVersion: '2018-01-01',
          query: {
            metricnames: group.names.join(','),
            timespan: `${isoHoursAgo(input.hours)}/${new Date().toISOString()}`,
            interval,
            aggregation: group.aggregation,
            ...(group.namespace ? { metricnamespace: group.namespace } : {}),
            ...(input.filter ? { $filter: input.filter, top: '10' } : {}),
          },
          signal: ctx.signal,
        }),
      })),
    );

    const series = responses.flatMap(({ group, response }) =>
      (response.value ?? []).flatMap((metric) =>
        (metric.timeseries ?? []).map((ts) =>
          summarizeSeries(
            metric.name?.value ?? '?',
            metric.unit,
            group.aggregation,
            ts.metadatavalues,
            ts.data ?? [],
          ),
        ),
      ),
    );

    const headline = series
      .slice(0, 4)
      .map(
        (s) =>
          `${s.metric}${s.dimensions ? ` ${JSON.stringify(s.dimensions)}` : ''}: ${s.aggregation.toLowerCase()} ${fmt(s.average)}, max ${fmt(s.max)}, latest ${fmt(s.latest)}`,
      )
      .join('; ');
    return {
      summary: `Last ${input.hours}h at ${interval}. ${headline || 'No data points.'}`,
      data: { interval, series },
      listKey: 'series',
    };
  },
});

function summarizeSeries(
  metric: string,
  unit: string | undefined,
  aggregation: Aggregation,
  metadata: { name?: { value?: string }; value?: string }[] | undefined,
  data: Record<string, number | string | undefined>[],
) {
  const field = aggregation.toLowerCase();
  const points = data
    .map((d) => [String(d.timeStamp), d[field]] as const)
    .filter((p): p is readonly [string, number] => typeof p[1] === 'number');
  const values = points.map((p) => p[1]);
  const dimensions = metadata?.length
    ? Object.fromEntries(metadata.map((m) => [m.name?.value ?? '?', m.value ?? '']))
    : undefined;
  const step = Math.max(1, Math.ceil(points.length / MAX_POINTS));
  return {
    metric,
    unit,
    aggregation,
    dimensions,
    min: values.length ? Math.min(...values) : undefined,
    average: values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : undefined,
    max: values.length ? Math.max(...values) : undefined,
    latest: values.at(-1),
    points: points.filter((_, i) => i % step === 0).map(([t, v]) => [t, round(v)]),
  };
}

function toAggregation(value: string | undefined): Aggregation {
  return AGGREGATIONS.find((a) => a.toLowerCase() === value?.toLowerCase()) ?? 'Average';
}

export function autoInterval(hours: number): string {
  if (hours <= 2) return 'PT1M';
  if (hours <= 12) return 'PT5M';
  if (hours <= 48) return 'PT15M';
  if (hours <= 168) return 'PT1H';
  return 'PT6H';
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function fmt(value: number | undefined): string {
  return value === undefined ? 'n/a' : String(round(value));
}
