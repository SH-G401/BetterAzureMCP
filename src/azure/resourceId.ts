import { ToolInputError } from './errors.js';

export interface ParsedResourceId {
  id: string;
  subscriptionId?: string;
  resourceGroup?: string;
  /** Resource provider namespace, e.g. `Microsoft.Web`. Undefined for subscriptions and groups. */
  provider?: string;
  /** Full resource type, e.g. `Microsoft.Web/sites/slots`. */
  type: string;
  name: string;
}

const SAFE_ID = /^\/[A-Za-z0-9._~()!*' @:,;=+$%/-]+$/;

/**
 * Parses and validates an Azure resource ID. Rejects anything that is not a plain ARM path,
 * so user input can never smuggle query strings, fragments or path traversal into a request.
 */
export function parseResourceId(input: string): ParsedResourceId {
  const id = input.trim().replace(/\/+$/, '');
  if (!SAFE_ID.test(id) || id.includes('//') || /(^|\/)\.\.?(\/|$)/.test(id)) {
    throw new ToolInputError(
      `"${input}" is not a valid Azure resource ID. Expected something like /subscriptions/<id>/resourceGroups/<group>/providers/<Namespace>/<type>/<name>.`,
    );
  }

  const segments = id.split('/').slice(1);
  const lower = segments.map((s) => s.toLowerCase());
  if (lower[0] !== 'subscriptions' || segments[1] === undefined) {
    throw new ToolInputError(`"${input}" must start with /subscriptions/<subscription-id>.`);
  }

  const subscriptionId = segments[1];
  const resourceGroup = lower[2] === 'resourcegroups' ? segments[3] : undefined;
  const providerIndex = lower.lastIndexOf('providers');

  if (providerIndex === -1) {
    if (segments.length === 2) {
      return {
        id,
        subscriptionId,
        type: 'Microsoft.Resources/subscriptions',
        name: subscriptionId,
      };
    }
    if (resourceGroup !== undefined && segments.length === 4) {
      return {
        id,
        subscriptionId,
        resourceGroup,
        type: 'Microsoft.Resources/resourceGroups',
        name: resourceGroup,
      };
    }
    throw new ToolInputError(`"${input}" is not a complete resource ID.`);
  }

  const provider = segments[providerIndex + 1];
  const rest = segments.slice(providerIndex + 2);
  if (provider === undefined || rest.length < 2 || rest.length % 2 !== 0) {
    throw new ToolInputError(`"${input}" is not a complete resource ID.`);
  }
  const typeParts = rest.filter((_, i) => i % 2 === 0);
  const name = rest[rest.length - 1] ?? '';
  return {
    id,
    subscriptionId,
    resourceGroup,
    provider,
    type: `${provider}/${typeParts.join('/')}`,
    name,
  };
}
