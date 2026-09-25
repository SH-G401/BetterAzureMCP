import { z } from 'zod';
import { parseResourceId } from '../azure/resourceId.js';
import { compact, resourceIdSchema } from './common.js';
import { defineTool } from './types.js';

interface AvailabilityStatus {
  properties?: {
    availabilityState?: string;
    summary?: string;
    detailedStatus?: string;
    reasonType?: string;
    reasonChronicity?: string;
    occuredTime?: string;
    reportedTime?: string;
    resolutionETA?: string;
    recommendedActions?: { action?: string }[];
  };
}

interface HealthEvent {
  name?: string;
  properties?: {
    title?: string;
    eventType?: string;
    status?: string;
    impactStartTime?: string;
    lastUpdateTime?: string;
    impact?: { impactedService?: string; impactedRegions?: { impactedRegion?: string }[] }[];
  };
}

export const resourceHealthTool = defineTool({
  name: 'azure_resource_health',
  title: 'Resource health and service issues',
  description: [
    "Shows whether Azure itself reports a resource as healthy: its current availability, recent availability changes with Azure's stated reason, and active Azure service issues affecting the subscription.",
    'Use it early when an app is down, to tell a platform problem apart from an application problem.',
  ].join(' '),
  inputSchema: z.object({
    resourceId: resourceIdSchema('Resource ID to check.'),
  }),
  async run(input, ctx) {
    const resource = parseResourceId(input.resourceId);
    const apiVersion = await ctx.apiVersions.resolveType(
      'Microsoft.ResourceHealth',
      'availabilityStatuses',
      ctx.signal,
    );

    const [current, history, events] = await Promise.all([
      ctx.arm.request<AvailabilityStatus>({
        method: 'GET',
        path: `${resource.id}/providers/Microsoft.ResourceHealth/availabilityStatuses/current`,
        apiVersion,
        signal: ctx.signal,
      }),
      ctx.arm
        .list<AvailabilityStatus>(
          {
            path: `${resource.id}/providers/Microsoft.ResourceHealth/availabilityStatuses`,
            apiVersion,
            signal: ctx.signal,
          },
          20,
        )
        .catch(() => ({ items: [], truncated: false })),
      ctx.arm
        .list<HealthEvent>(
          {
            path: `/subscriptions/${resource.subscriptionId ?? ''}/providers/Microsoft.ResourceHealth/events`,
            apiVersion,
            signal: ctx.signal,
          },
          100,
        )
        .catch(() => ({ items: [], truncated: false })),
    ]);

    const describe = (status: AvailabilityStatus) =>
      compact({
        state: status.properties?.availabilityState,
        summary: status.properties?.summary,
        detail: status.properties?.detailedStatus,
        reason: status.properties?.reasonType,
        chronicity: status.properties?.reasonChronicity,
        since: status.properties?.occuredTime,
        reported: status.properties?.reportedTime,
        resolutionETA: status.properties?.resolutionETA,
        recommendedActions: status.properties?.recommendedActions
          ?.map((a) => a.action)
          .filter(Boolean),
      });

    const activeIssues = events.items
      .filter((e) => e.properties?.status === 'Active')
      .slice(0, 10)
      .map((e) =>
        compact({
          trackingId: e.name,
          title: e.properties?.title,
          type: e.properties?.eventType,
          started: e.properties?.impactStartTime,
          updated: e.properties?.lastUpdateTime,
          services: e.properties?.impact?.map((i) => i.impactedService).filter(Boolean),
          regions: [
            ...new Set(
              e.properties?.impact?.flatMap(
                (i) => i.impactedRegions?.map((r) => r.impactedRegion) ?? [],
              ),
            ),
          ].filter(Boolean),
        }),
      );

    const state = current.properties?.availabilityState ?? 'Unknown';
    const issues =
      activeIssues.length > 0
        ? ` ${activeIssues.length} active Azure service issue(s) in this subscription.`
        : ' No active Azure service issues in this subscription.';
    return {
      summary: `${resource.name} is ${state}${current.properties?.summary ? `: ${current.properties.summary}` : '.'}${issues}`,
      data: {
        current: describe(current),
        history: history.items.slice(1).map(describe),
        activeServiceIssues: activeIssues,
      },
      listKey: 'history',
    };
  },
});
