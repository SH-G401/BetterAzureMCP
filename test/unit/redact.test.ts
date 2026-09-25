import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from '../../src/format/redact.js';

describe('redactSecrets', () => {
  it('masks values of secret-named properties and keeps the names', () => {
    expect(
      redactSecrets({
        adminPassword: 'hunter2',
        primaryKey: 'abc',
        instrumentationKey: '0000-1111',
        clientSecret: 's3cr3t',
        name: 'orders-api',
      }),
    ).toEqual({
      adminPassword: REDACTED,
      primaryKey: REDACTED,
      instrumentationKey: REDACTED,
      clientSecret: REDACTED,
      name: 'orders-api',
    });
  });

  it('keeps look-alike names that are not secrets', () => {
    const input = {
      partitionKey: '/tenantId',
      keyVaultSecretId: 'https://kv/secrets/x',
      publicKey: 'ssh-rsa AAA',
    };
    expect(redactSecrets(input)).toEqual(input);
  });

  it('masks connection strings, SAS URLs and JWTs regardless of the property name', () => {
    expect(
      redactSecrets({
        a: 'DefaultEndpointsProtocol=https;AccountName=x;AccountKey=abc==;',
        b: 'https://x.blob.core.windows.net/c?sv=2022&sig=abc%3D',
        c: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc',
        d: 'Server=tcp:db;Password=p@ss;',
      }),
    ).toEqual({ a: REDACTED, b: REDACTED, c: REDACTED, d: REDACTED });
  });

  it('masks name/value pairs such as app settings', () => {
    expect(
      redactSecrets({
        appSettings: [
          { name: 'DB_PASSWORD', value: 'x' },
          { name: 'API_TOKEN', value: 'y' },
          { name: 'ASPNETCORE_ENVIRONMENT', value: 'Production' },
        ],
      }),
    ).toEqual({
      appSettings: [
        { name: 'DB_PASSWORD', value: REDACTED },
        { name: 'API_TOKEN', value: REDACTED },
        { name: 'ASPNETCORE_ENVIRONMENT', value: 'Production' },
      ],
    });
  });

  it('does not modify the input', () => {
    const input = { password: 'x' };
    redactSecrets(input);
    expect(input.password).toBe('x');
  });
});
