import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('uses safe defaults', () => {
    expect(loadConfig({})).toEqual({
      tenantId: undefined,
      credential: 'auto',
      timeoutMs: 60_000,
      maxResponseBytes: 12 * 1024,
      showSecrets: false,
      subscriptions: undefined,
      maxMemoryBytes: 1024 * 1024 * 1024,
      logLevel: 'info',
    });
  });

  it('parses and normalizes BETTERAZUREMCP_SUBSCRIPTIONS', () => {
    const config = loadConfig({
      BETTERAZUREMCP_SUBSCRIPTIONS:
        ' 00000000-0000-0000-0000-00000000000A, 00000000-0000-0000-0000-00000000000b;00000000-0000-0000-0000-00000000000a',
    });
    expect(config.subscriptions).toEqual([
      '00000000-0000-0000-0000-00000000000a',
      '00000000-0000-0000-0000-00000000000b',
    ]);
  });

  it('reads BETTERAZUREMCP_* variables', () => {
    const config = loadConfig({
      BETTERAZUREMCP_TENANT_ID: 'contoso.onmicrosoft.com',
      BETTERAZUREMCP_CREDENTIAL: 'AzureCli',
      BETTERAZUREMCP_TIMEOUT_SECONDS: '30',
      BETTERAZUREMCP_MAX_RESPONSE_KB: '32',
      BETTERAZUREMCP_SHOW_SECRETS: 'true',
      BETTERAZUREMCP_LOG_LEVEL: 'debug',
    });
    expect(config).toMatchObject({
      tenantId: 'contoso.onmicrosoft.com',
      credential: 'azurecli',
      timeoutMs: 30_000,
      maxResponseBytes: 32 * 1024,
      showSecrets: true,
      logLevel: 'debug',
    });
  });

  it('treats empty values as unset', () => {
    expect(loadConfig({ BETTERAZUREMCP_TENANT_ID: '  ' }).tenantId).toBeUndefined();
  });

  it.each([
    ['BETTERAZUREMCP_CREDENTIAL', 'browser'],
    ['BETTERAZUREMCP_TIMEOUT_SECONDS', '0'],
    ['BETTERAZUREMCP_TIMEOUT_SECONDS', 'ten'],
    ['BETTERAZUREMCP_SHOW_SECRETS', 'maybe'],
    ['BETTERAZUREMCP_SUBSCRIPTIONS', 'prod-subscription'],
    ['BETTERAZUREMCP_SUBSCRIPTIONS', ' , '],
    ['BETTERAZUREMCP_MAX_MEMORY_MB', '64'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(ConfigError);
  });
});
