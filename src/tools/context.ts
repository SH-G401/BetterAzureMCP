import { z } from 'zod';
import { readTokenIdentity } from '../auth/tokenClaims.js';
import { ARM_SCOPE } from '../http/endpoints.js';
import { VERSION } from '../version.js';
import { defineTool } from './types.js';
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

export const contextTool = defineTool({
  name: 'azure_context',
  title: 'Azure sign-in and subscriptions',
  description: [
    'Shows who you are signed in to Azure as, which tenant is used, and the subscriptions you can read.',
    'Call this first when you need a subscription ID, or when another tool reports an authentication or permission problem.',
  ].join(' '),
  inputSchema: z.object({}),
  async run(_input, ctx) {
    const token = await ctx.credentials.getAccessToken(ARM_SCOPE, ctx.signal);
    const identity = readTokenIdentity(token.token);
    const status = ctx.credentials.getStatus();

    const [subscriptions, tenants] = await Promise.all([
      ctx.arm.list<Subscription>(
        { path: '/subscriptions', apiVersion: '2022-12-01', signal: ctx.signal },
        500,
      ),
      ctx.arm.list<Tenant>({ path: '/tenants', apiVersion: '2022-12-01', signal: ctx.signal }, 100),
    ]);

    const who = identity.principal ?? identity.objectId ?? 'unknown identity';
    const via = status.state === 'ok' ? ` via ${status.source}` : '';
    const enabled = subscriptions.items.filter((s) => s.state === 'Enabled').length;

    return {
      summary: `Signed in as ${who}${via}, tenant ${identity.tenantId ?? 'unknown'}. ${plural(subscriptions.items.length, 'subscription')} accessible (${enabled} enabled).`,
      data: {
        identity: {
          principal: identity.principal,
          principalType: identity.principalType,
          objectId: identity.objectId,
          tenantId: identity.tenantId,
          credential: status.state === 'ok' ? status.source : undefined,
          tokenExpiresAt: new Date(token.expiresOnTimestamp).toISOString(),
        },
        tenants: tenants.items.map((t) => ({
          tenantId: t.tenantId,
          name: t.displayName,
          domain: t.defaultDomain,
        })),
        subscriptions: subscriptions.items.map((s) => ({
          id: s.subscriptionId,
          name: s.displayName,
          state: s.state,
          tenantId: s.tenantId,
        })),
        server: {
          version: VERSION,
          readOnly: true,
          tenantOverride: ctx.config.tenantId,
          timeoutSeconds: ctx.config.timeoutMs / 1000,
          secretsMasked: !ctx.config.showSecrets,
        },
      },
      listKey: 'subscriptions',
    };
  },
});
