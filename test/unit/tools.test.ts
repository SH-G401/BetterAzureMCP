import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/logger.js';
import { runTool } from '../../src/server.js';
import { contextTool } from '../../src/tools/context.js';
import { findResourcesTool } from '../../src/tools/findResources.js';
import { getResourceTool } from '../../src/tools/getResource.js';
import { TOOLS } from '../../src/tools/index.js';
import { resourceGraphQueryTool } from '../../src/tools/resourceGraphQuery.js';
import { defineTool } from '../../src/tools/types.js';
import { servicesWith, type RecordedRequest } from '../helpers.js';
import { z } from 'zod';

const SUB = '00000000-0000-0000-0000-000000000001';
const SITE_ID = `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.Web/sites/orders-api`;
const never = new AbortController().signal;

const textOf = (result: Awaited<ReturnType<typeof runTool>>): string => {
  const first = result.content[0];
  return first?.type === 'text' ? first.text : '';
};

function graphResponse(rows: Record<string, unknown>[]) {
  return {
    body: { totalRecords: rows.length, count: rows.length, data: rows, resultTruncated: 'false' },
  };
}

describe('tool catalog', () => {
  it('has unique, stable names', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'azure_context',
      'azure_find_resources',
      'azure_resource_graph_query',
      'azure_get_resource',
    ]);
  });

  it('keeps descriptions short enough to be cheap in every request', () => {
    for (const tool of TOOLS) expect(tool.description.length).toBeLessThan(1200);
  });
});

describe('azure_find_resources', () => {
  it('builds an escaped Resource Graph query', async () => {
    const { services, http } = servicesWith(() =>
      graphResponse([{ id: SITE_ID, name: 'orders-api' }]),
    );
    const input = findResourcesTool.inputSchema.parse({
      name: "o'reilly",
      type: 'Microsoft.Web/sites',
      tags: { env: 'prod' },
    });

    const result = await runTool(findResourcesTool, input, services, silentLogger, never);

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toMatch(/^Found 1 resource\./);
    const request = http.requests[0] as RecordedRequest;
    expect(request.method).toBe('POST');
    expect(request.url.pathname).toBe('/providers/Microsoft.ResourceGraph/resources');
    const body = request.body as { query: string; options: { $top: number } };
    expect(body.query).toContain("name contains @'o''reilly'");
    expect(body.query).toContain("type =~ @'Microsoft.Web/sites'");
    expect(body.query).toContain("tostring(tags[@'env']) == @'prod'");
    expect(body.options.$top).toBe(50);
  });

  it('rejects multi-line input', () => {
    expect(() => findResourcesTool.inputSchema.parse({ name: 'a\n| project secrets' })).toThrow();
  });
});

describe('azure_resource_graph_query', () => {
  it('passes the query through and reports paging', async () => {
    const { services, http } = servicesWith(() => ({
      body: {
        totalRecords: 250,
        count: 1,
        data: [{ n: 1 }],
        $skipToken: 'next',
        resultTruncated: 'false',
      },
    }));
    const input = resourceGraphQueryTool.inputSchema.parse({
      query: 'resources | take 1',
      subscriptionIds: [SUB],
    });

    const text = textOf(
      await runTool(resourceGraphQueryTool, input, services, silentLogger, never),
    );

    expect(text).toContain('More rows are available');
    expect(http.requests[0]?.body).toMatchObject({
      query: 'resources | take 1',
      subscriptions: [SUB],
    });
  });
});

describe('azure_get_resource', () => {
  it('resolves the newest stable API version and masks secrets', async () => {
    const { services, http } = servicesWith((req) => {
      if (req.url.pathname === '/providers/Microsoft.Web') {
        return {
          body: {
            resourceTypes: [
              {
                resourceType: 'sites',
                apiVersions: ['2025-01-01-preview', '2024-04-01', '2023-12-01'],
              },
            ],
          },
        };
      }
      if (req.url.pathname === SITE_ID) {
        return {
          body: {
            id: SITE_ID,
            name: 'orders-api',
            type: 'Microsoft.Web/sites',
            location: 'westeurope',
            properties: { state: 'Running', siteConfig: { publishingPassword: 'p' } },
          },
        };
      }
      return undefined;
    });

    const result = await runTool(
      getResourceTool,
      getResourceTool.inputSchema.parse({ resourceId: SITE_ID }),
      services,
      silentLogger,
      never,
    );

    expect(textOf(result)).toMatch(
      /^Microsoft\.Web\/sites "orders-api" in westeurope, state Running \(API version 2024-04-01\)/,
    );
    expect(textOf(result)).not.toContain('"p"');
    expect(http.requests.at(-1)?.url.searchParams.get('api-version')).toBe('2024-04-01');
  });

  it('turns a 404 into an actionable message', async () => {
    const { services } = servicesWith(() => ({
      status: 404,
      body: { error: { code: 'ResourceNotFound', message: 'The Resource was not found.' } },
    }));
    const result = await runTool(
      getResourceTool,
      getResourceTool.inputSchema.parse({ resourceId: SITE_ID, apiVersion: '2024-04-01' }),
      services,
      silentLogger,
      never,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('404 ResourceNotFound');
    expect(textOf(result)).toContain('azure_find_resources');
    expect(textOf(result)).toContain('Request ID: req-123');
  });
});

describe('azure_context', () => {
  it('reports identity and subscriptions', async () => {
    const { services } = servicesWith((req) => {
      if (req.url.pathname === '/subscriptions') {
        return {
          body: {
            value: [
              { subscriptionId: SUB, displayName: 'Prod', state: 'Enabled', tenantId: 'tenant-1' },
              { subscriptionId: 'x', displayName: 'Old', state: 'Disabled', tenantId: 'tenant-1' },
            ],
          },
        };
      }
      if (req.url.pathname === '/tenants') return { body: { value: [{ tenantId: 'tenant-1' }] } };
      return undefined;
    });

    const text = textOf(await runTool(contextTool, {}, services, silentLogger, never));
    expect(text).toMatch(
      /^Signed in as dev@contoso\.com via fake azurecli, tenant tenant-1\. 2 subscriptions accessible \(1 enabled\)\./,
    );
  });
});

describe('runTool', () => {
  it('stops a tool at the deadline, even if it ignores the signal', async () => {
    const { services } = servicesWith(() => undefined, { timeoutMs: 50 });
    const stuck = defineTool({
      name: 'stuck',
      title: 'Stuck',
      description: 'Never finishes.',
      inputSchema: z.object({}),
      run: () => new Promise(() => undefined),
    });

    const started = Date.now();
    const result = await runTool(stuck, {}, services, silentLogger, never);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('did not finish within 0.05 seconds');
  });

  it('turns unexpected exceptions into error results', async () => {
    const { services } = servicesWith(() => undefined);
    const broken = defineTool({
      name: 'broken',
      title: 'Broken',
      description: 'Throws.',
      inputSchema: z.object({}),
      run: () => Promise.reject(new Error('boom')),
    });
    const result = await runTool(broken, {}, services, silentLogger, never);
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Unexpected error: boom' }],
    });
  });
});
