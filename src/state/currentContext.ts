import { ToolInputError } from '../azure/errors.js';
import type { AzureServices } from '../tools/types.js';
import type { RememberedContext } from './contextStore.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBSCRIPTION_IN_ID =
  /\/subscriptions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * The remembered subscription and directory, if they still apply: remembering is enabled,
 * the directory matches a configured BETTERAZUREMCP_TENANT_ID, and the subscription is inside
 * BETTERAZUREMCP_SUBSCRIPTIONS.
 */
export function currentContext(services: AzureServices): RememberedContext | undefined {
  if (!services.config.rememberContext) return undefined;
  const context = services.context.get();
  const configured = services.config.tenantId;
  if (configured !== undefined && GUID.test(configured) && context.tenantId !== undefined) {
    if (context.tenantId !== configured.toLowerCase()) return undefined;
  }
  const scope = services.config.subscriptions;
  if (scope !== undefined && context.subscriptionId !== undefined) {
    if (!scope.includes(context.subscriptionId)) {
      delete context.subscriptionId;
      delete context.subscriptionName;
    }
  }
  return context.subscriptionId === undefined && context.tenantId === undefined
    ? undefined
    : context;
}

/** The scope a tool should use: the one given, else the current subscription. */
export function scopeOrCurrent(services: AzureServices, scope: string | undefined): string {
  if (scope !== undefined) return scope;
  const subscriptionId = currentContext(services)?.subscriptionId;
  if (subscriptionId === undefined) {
    throw new ToolInputError(
      'No scope was given and there is no current subscription yet. Pass a resource, resource group or subscription ID, or choose a subscription with azure_context.',
    );
  }
  return `/subscriptions/${subscriptionId}`;
}

export function describeContext(context: RememberedContext): string {
  const subscription = context.subscriptionId
    ? `subscription ${context.subscriptionName ? `"${context.subscriptionName}" (${context.subscriptionId})` : context.subscriptionId}`
    : undefined;
  const tenant = context.tenantId
    ? `directory ${context.tenantName ? `${context.tenantName} (${context.tenantId})` : context.tenantId}`
    : undefined;
  return [subscription, tenant].filter(Boolean).join(' in ');
}

/**
 * Called after a tool call succeeds: the subscription it worked in becomes the current one,
 * together with the directory of the token that was used.
 */
export function recordUsage(toolName: string, input: unknown, services: AzureServices): void {
  if (!services.config.rememberContext || toolName === 'azure_context') return;
  const subscriptionId = findSubscription(input);
  if (subscriptionId === undefined) return;
  const scope = services.config.subscriptions;
  if (scope !== undefined && !scope.includes(subscriptionId)) return;

  const tenantId = services.credentials.cachedTenantId()?.toLowerCase();
  services.context.remember({ subscriptionId, ...(tenantId ? { tenantId } : {}) });
  void fillNames(services);
}

/** The first subscription ID named in a tool's input, if any. */
export function findSubscription(input: unknown): string | undefined {
  if (typeof input === 'string') return SUBSCRIPTION_IN_ID.exec(input)?.[1]?.toLowerCase();
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findSubscription(item);
      if (found) return found;
    }
    return undefined;
  }
  if (input !== null && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) {
      if (key === 'subscriptionIds' && Array.isArray(value) && value.length === 1) {
        const id = String(value[0]).toLowerCase();
        if (GUID.test(id)) return id;
      }
      const found = findSubscription(value);
      if (found) return found;
    }
  }
  return undefined;
}

const filling = new WeakMap<object, Promise<void>>();

/** Looks up display names for the current subscription and directory when they are missing. */
export function fillNames(services: AzureServices): Promise<void> {
  const running = filling.get(services.context);
  if (running !== undefined) return running;
  const task = (async () => {
    try {
      const context = services.context.get();
      if (context.subscriptionId && !context.subscriptionName) {
        const sub = await services.arm.request<{ displayName?: string }>({
          method: 'GET',
          path: `/subscriptions/${context.subscriptionId}`,
          apiVersion: '2022-12-01',
        });
        if (sub.displayName && services.context.get().subscriptionId === context.subscriptionId) {
          services.context.remember({ subscriptionName: sub.displayName });
        }
      }
      if (context.tenantId && !context.tenantName) {
        const tenants = await services.arm.list<{
          tenantId: string;
          displayName?: string;
          defaultDomain?: string;
        }>({ path: '/tenants', apiVersion: '2022-12-01' }, 100);
        const tenant = tenants.items.find((t) => t.tenantId.toLowerCase() === context.tenantId);
        const name = tenant?.defaultDomain ?? tenant?.displayName;
        if (name && services.context.get().tenantId === context.tenantId) {
          services.context.remember({ tenantName: name });
        }
      }
    } catch {
      // Names are a convenience; the IDs are what matter.
    } finally {
      filling.delete(services.context);
    }
  })();
  filling.set(services.context, task);
  return task;
}
