import { describe, expect, it } from 'vitest';
import { pickApiVersion } from '../../src/azure/apiVersions.js';
import { ToolInputError } from '../../src/azure/errors.js';
import { parseResourceId } from '../../src/azure/resourceId.js';

const SUB = '/subscriptions/00000000-0000-0000-0000-000000000001';

describe('parseResourceId', () => {
  it('parses a top-level resource', () => {
    expect(
      parseResourceId(`${SUB}/resourceGroups/rg/providers/Microsoft.Web/sites/orders-api`),
    ).toEqual({
      id: `${SUB}/resourceGroups/rg/providers/Microsoft.Web/sites/orders-api`,
      subscriptionId: '00000000-0000-0000-0000-000000000001',
      resourceGroup: 'rg',
      provider: 'Microsoft.Web',
      type: 'Microsoft.Web/sites',
      name: 'orders-api',
    });
  });

  it('parses child resources', () => {
    const parsed = parseResourceId(
      `${SUB}/resourceGroups/rg/providers/Microsoft.Web/sites/app/slots/staging/`,
    );
    expect(parsed).toMatchObject({ type: 'Microsoft.Web/sites/slots', name: 'staging' });
  });

  it('parses extension resources by their last provider', () => {
    const parsed = parseResourceId(
      `${SUB}/resourceGroups/rg/providers/Microsoft.Web/sites/app/providers/Microsoft.Insights/diagnosticSettings/logs`,
    );
    expect(parsed).toMatchObject({
      provider: 'Microsoft.Insights',
      type: 'Microsoft.Insights/diagnosticSettings',
    });
  });

  it('parses subscriptions and resource groups', () => {
    expect(parseResourceId(SUB).type).toBe('Microsoft.Resources/subscriptions');
    expect(parseResourceId(`${SUB}/resourceGroups/rg`).type).toBe(
      'Microsoft.Resources/resourceGroups',
    );
  });

  it.each([
    'orders-api',
    `${SUB}/../../providers/x`,
    `${SUB}/resourceGroups/rg?api-version=1`,
    `${SUB}/resourceGroups/rg#x`,
    `${SUB}//resourceGroups/rg`,
    `${SUB}/resourceGroups/rg/providers/Microsoft.Web/sites`,
    'https://management.azure.com/subscriptions/x',
    '/providers/Microsoft.Management/managementGroups/mg',
  ])('rejects %s', (input) => {
    expect(() => parseResourceId(input)).toThrow(ToolInputError);
  });
});

describe('pickApiVersion', () => {
  it('prefers the newest stable version', () => {
    expect(pickApiVersion(['2022-03-01', '2024-04-01', '2025-01-01-preview'])).toBe('2024-04-01');
  });

  it('falls back to the newest preview', () => {
    expect(pickApiVersion(['2023-01-01-preview', '2024-02-01-preview'])).toBe('2024-02-01-preview');
  });

  it('returns undefined when there is nothing to pick', () => {
    expect(pickApiVersion([])).toBeUndefined();
  });
});
