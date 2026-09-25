import { z } from 'zod';
import { readTokenIdentity } from '../auth/tokenClaims.js';
import { ToolInputError } from '../azure/errors.js';
import { ARM_SCOPE } from '../http/endpoints.js';
import { currentContext, describeContext } from '../state/currentContext.js';
import { VERSION } from '../version.js';
import { defineTool, type ToolContext } from './types.js';
import { plural } from './common.js';

interface Subscription {
  subscriptionId: string;
  displayName: string;
  state: string;
  tenantId: string;
}

interface Tenant {
  tenantId: string;
  displayName?: string;
  defaultDomain?: string;
}

const nameSchema = (what: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((v) => !/[\r\n]/.test(v), `${what} must be a single line.`);

export const contextTool = defineTool({
  name: 'azure_context',
  title: 'Azure sign-in, directory and subscriptions',
  description: [
    'Shows who you are signed in to Azure as, the directory (tenant), the subscriptions you can read, and the current subscription that other tools use when none is named.',
    'Pass subscription (name or ID) to switch the current subscription, or tenant (domain, name or ID) to switch directory. The choice is remembered across sessions.',
    'Call this when you need a subscription ID, when the user wants to look somewhere else, or when a tool reports a sign-in or permission problem.',
  ].join(' '),
  inputSchema: z.object({
    subscription: nameSchema('subscription')
      .optional()
      .describe('Make this subscription (display name or ID) the current one.'),
    tenant: nameSchema('tenant')
      .optional()
      .describe('Switch to this directory (domain such as contoso.onmicrosoft.com, name, or ID).'),
  }),
  async run(input, ctx) {
    if (input.tenant !== undefined) await switchTenant(ctx, input.tenant);

    const token = await ctx.credentials.getAccessToken(ARM_SCOPE, ctx.signal);
    const identity = readTokenIdentity(token.token);
    const status = ctx.credentials.getStatus();

    const [subscriptions, tenants] = await Promise.all([
      ctx.arm.list<Subscription>(
        { path: '/subscriptions', apiVersion: '2022-12-01', signal: ctx.signal },
        500,
      ),
      listTenants(ctx),
    ]);

    const scope = ctx.config.subscriptions;
    const visible = scope
      ? subscriptions.items.filter((s) => scope.includes(s.subscriptionId.toLowerCase()))
      : subscriptions.items;
    const tenantName = (id: string | undefined) => {
      const t = tenants.find((x) => x.tenantId.toLowerCase() === id?.toLowerCase());
      return t?.defaultDomain ?? t?.displayName;
    };

    if (input.subscription !== undefined) {
      const chosen = matchSubscription(visible, input.subscription);
      rememberSubscription(ctx, chosen, tenantName(chosen.tenantId));
    } else if (ctx.config.rememberContext) {
      const current = currentContext(ctx)?.subscriptionId;
      const known = visible.find((s) => s.subscriptionId.toLowerCase() === current);
      const only = visible.length === 1 ? visible[0] : undefined;
      if (known !== undefined) {
        // Refresh names; they may have changed or never been looked up.
        rememberSubscription(ctx, known, tenantName(known.tenantId));
      } else if (only !== undefined) {
        // Nothing to choose from: the only subscription is the current one.
        rememberSubscription(ctx, only, tenantName(only.tenantId));
      }
    }

    const current = currentContext(ctx);
    const who = identity.principal ?? identity.objectId ?? 'unknown identity';
    const via = status.state === 'ok' ? ` via ${status.source}` : '';
    const directory = tenantName(identity.tenantId);
    const enabled = visible.filter((s) => s.state === 'Enabled').length;
    const limited = scope
      ? ` Limited to ${plural(scope.length, 'configured subscription')} (BETTERAZUREMCP_SUBSCRIPTIONS).`
      : '';
    const currentLine = !ctx.config.rememberContext
      ? ''
      : current?.subscriptionId !== undefined
        ? ` Current: ${describeContext(current)}. Tools use it when no other subscription is named.`
        : ' No current subscription: pass subscription to choose one; it is remembered for later sessions.';

    return {
      summary: `Signed in as ${who}${via}, directory ${directory ? `${directory} (${identity.tenantId ?? '?'})` : (identity.tenantId ?? 'unknown')}. ${plural(visible.length, 'subscription')} accessible (${enabled} enabled).${limited}${currentLine}`,
      data: {
        identity: {
          principal: identity.principal,
          principalType: identity.principalType,
          objectId: identity.objectId,
          tenantId: identity.tenantId,
          credential: status.state === 'ok' ? status.source : undefined,
          tokenExpiresAt: new Date(token.expiresOnTimestamp).toISOString(),
        },
        current,
        tenants: tenants.map((t) => ({
          tenantId: t.tenantId,
          name: t.displayName,
          domain: t.defaultDomain,
        })),
        subscriptions: visible.map((s) => ({
          id: s.subscriptionId,
          name: s.displayName,
          state: s.state,
          tenantId: s.tenantId,
        })),
        server: {
          version: VERSION,
          readOnly: true,
          tenantOverride: ctx.config.tenantId,
          subscriptionScope: scope,
          rememberContext: ctx.config.rememberContext,
          timeoutSeconds: ctx.config.timeoutMs / 1000,
          secretsMasked: !ctx.config.showSecrets,
        },
      },
      listKey: 'subscriptions',
    };
  },
});

async function listTenants(ctx: ToolContext): Promise<Tenant[]> {
  const page = await ctx.arm.list<Tenant>(
    { path: '/tenants', apiVersion: '2022-12-01', signal: ctx.signal },
    100,
  );
  return page.items;
}

async function switchTenant(ctx: ToolContext, wanted: string): Promise<void> {
  if (ctx.config.tenantId !== undefined) {
    throw new ToolInputError(
      `The directory is fixed to ${ctx.config.tenantId} by BETTERAZUREMCP_TENANT_ID. Change or remove that setting to switch directories.`,
    );
  }
  const tenants = await listTenants(ctx);
  const needle = wanted.toLowerCase();
  const match = tenants.find((t) =>
    [t.tenantId, t.defaultDomain, t.displayName].some((v) => v?.toLowerCase() === needle),
  );
  if (match === undefined) {
    const known = tenants.map((t) => t.defaultDomain ?? t.displayName ?? t.tenantId).join(', ');
    throw new ToolInputError(
      `No directory "${wanted}" is available to this account. Available: ${known || 'none'}. To use another account, run "az login --tenant <directory>".`,
    );
  }
  ctx.credentials.useTenant(match.tenantId.toLowerCase());
  if (ctx.config.rememberContext) {
    ctx.context.remember({
      tenantId: match.tenantId.toLowerCase(),
      tenantName: match.defaultDomain ?? match.displayName,
      subscriptionId: undefined,
    });
  }
}

function matchSubscription(subscriptions: readonly Subscription[], wanted: string): Subscription {
  const needle = wanted.toLowerCase();
  const exact = subscriptions.find(
    (s) => s.subscriptionId.toLowerCase() === needle || s.displayName.toLowerCase() === needle,
  );
  if (exact !== undefined) return exact;
  const partial = subscriptions.filter((s) => s.displayName.toLowerCase().includes(needle));
  const [only] = partial;
  if (partial.length === 1 && only !== undefined) return only;
  const names = (partial.length > 1 ? partial : subscriptions)
    .slice(0, 25)
    .map((s) => `"${s.displayName}"`)
    .join(', ');
  throw new ToolInputError(
    partial.length > 1
      ? `"${wanted}" matches several subscriptions: ${names}. Use the full name or the ID.`
      : `No subscription "${wanted}" in this directory. Available: ${names || 'none'}. For a subscription in another directory, pass tenant as well.`,
  );
}

function rememberSubscription(
  ctx: ToolContext,
  subscription: Subscription,
  tenantName: string | undefined,
): void {
  if (!ctx.config.rememberContext) {
    throw new ToolInputError(
      'Remembering a current subscription is turned off (BETTERAZUREMCP_REMEMBER_CONTEXT=false). Pass resource or subscription IDs to each tool instead.',
    );
  }
  ctx.context.remember({
    subscriptionId: subscription.subscriptionId.toLowerCase(),
    subscriptionName: subscription.displayName,
    tenantId: subscription.tenantId.toLowerCase(),
    ...(tenantName ? { tenantName } : {}),
  });
}
