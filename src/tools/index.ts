import { contextTool } from './context.js';
import { findResourcesTool } from './findResources.js';
import { getResourceTool } from './getResource.js';
import { resourceGraphQueryTool } from './resourceGraphQuery.js';
import type { ToolDefinition } from './types.js';

/** Every tool the server exposes. Tool names are a public API: never rename one in a minor release. */
export const TOOLS: readonly ToolDefinition[] = [
  contextTool,
  findResourcesTool,
  resourceGraphQueryTool,
  getResourceTool,
];
