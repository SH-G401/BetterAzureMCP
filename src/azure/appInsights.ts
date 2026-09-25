import type { ArmClient } from './armClient.js';
import { ToolInputError } from './errors.js';
import { parseResourceId } from './resourceId.js';
import { kqlString, queryResourceGraph } from './resourceGraph.js';

export interface AppInsightsComponent {
  id: string;
  name: string;
  /** Log Analytics workspace that stores the telemetry. */
  workspaceResourceId?: string;
}

const COMPONENT_TYPE = 'microsoft.insights/components';

/**
 * Finds the Application Insights resource for `resourceId`: the resource itself when it is an
 * Application Insights component, otherwise the component linked to it (App Service, Functions
 * and Container Apps link through a `hidden-link:<resource id>` tag).
 */
export async function resolveAppInsights(
  arm: ArmClient,
  resourceId: string,
  signal?: AbortSignal,
): Promise<AppInsightsComponent> {
  const resource = parseResourceId(resourceId);
  if (resource.type.toLowerCase() === COMPONENT_TYPE) {
    const component = await arm.request<{
      id: string;
      name: string;
      properties?: { WorkspaceResourceId?: string };
    }>({ method: 'GET', path: resource.id, apiVersion: '2020-02-02', signal });
    return {
      id: component.id,
      name: component.name,
      workspaceResourceId: component.properties?.WorkspaceResourceId,
    };
  }

  const linked = await findLinkedAppInsights(arm, resource.id, signal);
  const first = linked[0];
  if (first === undefined) {
    throw new ToolInputError(
      `No Application Insights resource is linked to ${resource.name}. Pass the Application Insights resource ID instead (find it with azure_find_resources, type microsoft.insights/components), or use azure_telemetry_locations to see where this resource sends telemetry.`,
    );
  }
  return first;
}

/** Application Insights components that carry a `hidden-link` tag pointing at `resourceId`. */
export async function findLinkedAppInsights(
  arm: ArmClient,
  resourceId: string,
  signal?: AbortSignal,
): Promise<AppInsightsComponent[]> {
  const subscriptionId = parseResourceId(resourceId).subscriptionId;
  const result = await queryResourceGraph(arm, {
    query: [
      'resources',
      `| where type =~ ${kqlString(COMPONENT_TYPE)}`,
      `| where tostring(tags) contains ${kqlString(`hidden-link:${resourceId}"`)}`,
      '| project id, name, workspaceResourceId = tostring(properties.WorkspaceResourceId)',
    ].join('\n'),
    subscriptionIds: subscriptionId ? [subscriptionId] : undefined,
    top: 5,
    signal,
  });
  return result.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    workspaceResourceId:
      typeof row.workspaceResourceId === 'string' && row.workspaceResourceId !== ''
        ? row.workspaceResourceId
        : undefined,
  }));
}

export function requireWorkspace(component: AppInsightsComponent): string {
  if (!component.workspaceResourceId) {
    throw new ToolInputError(
      `Application Insights resource ${component.name} is not workspace-based, so its telemetry cannot be queried. Migrate it to a workspace-based resource (classic Application Insights was retired in 2024).`,
    );
  }
  return component.workspaceResourceId;
}
