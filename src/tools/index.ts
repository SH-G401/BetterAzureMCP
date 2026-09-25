import { activityLogTool } from './activityLog.js';
import { aksOverviewTool, aksPodLogsTool, aksWorkloadsTool } from './aks.js';
import { appInsightsFailuresTool, appInsightsTraceTool } from './appInsights.js';
import { appServiceLogsTool, appServiceOverviewTool } from './appService.js';
import { containerAppLogsTool, containerAppOverviewTool } from './containerApps.js';
import { contextTool } from './context.js';
import { diagnosticsTool } from './diagnostics.js';
import { findResourcesTool } from './findResources.js';
import { getResourceTool } from './getResource.js';
import { logsQueryTool } from './logsQuery.js';
import { metricsTool } from './metrics.js';
import { recentChangesTool } from './recentChanges.js';
import { resourceGraphQueryTool } from './resourceGraphQuery.js';
import { resourceHealthTool } from './resourceHealth.js';
import { telemetryLocationsTool } from './telemetryLocations.js';
import type { ToolDefinition } from './types.js';

/** Every tool the server exposes. Tool names are a public API: never rename one in a minor release. */
export const TOOLS: readonly ToolDefinition[] = [
  // Orientation
  contextTool,
  findResourcesTool,
  resourceGraphQueryTool,
  getResourceTool,
  // What is wrong with this resource?
  resourceHealthTool,
  recentChangesTool,
  activityLogTool,
  telemetryLocationsTool,
  metricsTool,
  // Telemetry
  logsQueryTool,
  appInsightsFailuresTool,
  appInsightsTraceTool,
  // Platforms
  appServiceOverviewTool,
  appServiceLogsTool,
  diagnosticsTool,
  containerAppOverviewTool,
  containerAppLogsTool,
  aksOverviewTool,
  aksWorkloadsTool,
  aksPodLogsTool,
];
