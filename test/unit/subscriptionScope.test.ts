import { describe, expect, it } from 'vitest';
import { contextTool } from '../../src/tools/context.js';
import { findResourcesTool } from '../../src/tools/findResources.js';
import { getResourceTool } from '../../src/tools/getResource.js';
import { logsQueryTool } from '../../src/tools/logsQuery.js';
import { resourceGraphQueryTool } from '../../src/tools/resourceGraphQuery.js';
import { checkSubscriptionScope } from '../../src/http/policies.js';
import { callTool, servicesWith } from '../helpers.js';

const ALLOWED = '00000000-0000-0000-0000-00000000000a';
const OTHER = '00000000-0000-0000-0000-00000000000b';
const allow = new Set([ALLOWED]);
const arm = (path: string) => new URL(`https://management.azure.com${path}`);

const graph = { body: { totalRecords: 0, count: 0, data: [], resultTruncated: 'false' } };

describe('checkSubscriptionScope', () => {
  it('allows requests without a subscription and inside the allowlist', () => {
    expect(checkSubscriptionScope(arm('/subscriptions'), undefined, allow)).toBeUndefined();
    expect(
      checkSubscriptionScope(arm('/providers/Microsoft.Web'), undefined, allow),
    ).toBeUndefined();
    expect(
      checkSubscriptionScope(
        arm(`/subscriptions/${ALLOWED.toUpperCase()}/resourceGroups/rg`),
        undefined,
        allow,
      ),
    ).toBeUndefined();
  });

  it('blocks other subscriptions on ARM and Log Analytics', () => {
    expect(
      checkSubscriptionScope(arm(`/subscriptions/${OTHER}/resourceGroups/rg`), undefined, allow),
    ).toContain(OTHER);
    expect(
      checkSubscriptionScope(
        new URL(`https://api.loganalytics.io/v1/subscriptions/${OTHER}/resourceGroups/rg/query`),
        undefined,
        allow,
      ),
    ).toContain(OTHER);
  });

  it('requires Resource Graph queries to be limited to the allowlist', () => {
    const rg = arm('/providers/Microsoft.ResourceGraph/resources');
    expect(checkSubscriptionScope(rg, JSON.stringify({ query: 'resources' }), allow)).toMatch(
      /must be limited/,
    );
    expect(
      checkSubscriptionScope(
        rg,
        JSON.stringify({ subscriptions: [ALLOWED], managementGroups: ['mg'] }),
        allow,
      ),
    ).toMatch(/must be limited/);
    expect(
      checkSubscriptionScope(rg, JSON.stringify({ subscriptions: [ALLOWED, OTHER] }), allow),
    ).toContain(OTHER);
    expect(
      checkSubscriptionScope(rg, JSON.stringify({ subscriptions: [ALLOWED] }), allow),
    ).toBeUndefined();
  });
});

describe('BETTERAZUREMCP_SUBSCRIPTIONS in tools', () => {
  const scoped = { subscriptions: [ALLOWED] };

  it('limits Resource Graph searches to the configured subscriptions', async () => {
    const { services, http } = servicesWith(() => graph, scoped);
    await callTool(findResourcesTool, { name: 'api' }, services);
    expect((http.requests[0]?.body as { subscriptions: string[] }).subscriptions).toEqual([
      ALLOWED,
    ]);
  });

  it('rejects explicit subscriptions and management groups outside the scope', async () => {
    const { services, http } = servicesWith(() => graph, scoped);
    const outside = await callTool(
      resourceGraphQueryTool,
      { query: 'resources', subscriptionIds: [OTHER] },
      services,
    );
    expect(outside.isError).toBe(true);
    expect(outside.text).toContain('outside the subscriptions this server is limited to');
    const mg = await callTool(
      resourceGraphQueryTool,
      { query: 'resources', managementGroupIds: ['mg'] },
      services,
    );
    expect(mg.isError).toBe(true);
    expect(http.requests).toHaveLength(0);
  });

  it('blocks resource and log reads in other subscriptions before sending', async () => {
    const { services, http } = servicesWith(() => ({ body: {} }), scoped);
    const resource = await callTool(
      getResourceTool,
      {
        resourceId: `/subscriptions/${OTHER}/resourceGroups/rg/providers/Microsoft.Web/sites/app`,
        apiVersion: '2024-04-01',
      },
      services,
    );
    expect(resource.isError).toBe(true);
    expect(resource.text).toContain('outside BETTERAZUREMCP_SUBSCRIPTIONS');
    const logs = await callTool(
      logsQueryTool,
      {
        scope: `/subscriptions/${OTHER}/resourceGroups/rg/providers/Microsoft.Web/sites/app`,
        query: 'AppRequests',
      },
      services,
    );
    expect(logs.isError).toBe(true);
    expect(http.requests).toHaveLength(0);
  });

  it('only lists configured subscriptions in azure_context', async () => {
    const { services } = servicesWith((req) => {
      if (req.url.pathname === '/subscriptions') {
        return {
          body: {
            value: [
              { subscriptionId: ALLOWED, displayName: 'Prod', state: 'Enabled', tenantId: 't' },
              { subscriptionId: OTHER, displayName: 'Other', state: 'Enabled', tenantId: 't' },
            ],
          },
        };
      }
      return { body: { value: [] } };
    }, scoped);
    const { text } = await callTool(contextTool, {}, services);
    expect(text).toContain(
      '1 subscription accessible (1 enabled). Limited to 1 configured subscription',
    );
    expect(text).not.toContain(OTHER);
  });
});
