import { describe, expect, it } from 'vitest';
import { ALLOWED_ENDPOINTS, findAllowedEndpoint } from '../../src/http/endpoints.js';

describe('egress allowlist', () => {
  it('is exactly the documented list of hosts', () => {
    // Changing this list changes the privacy promise. Update SECURITY.md in the same change.
    expect(ALLOWED_ENDPOINTS.map((e) => e.host)).toEqual(['management.azure.com']);
  });

  it.each(['https://management.azure.com/subscriptions', 'https://MANAGEMENT.AZURE.COM/providers'])(
    'allows %s',
    (url) => {
      expect(findAllowedEndpoint(new URL(url))).toBeDefined();
    },
  );

  it.each([
    'http://management.azure.com/subscriptions',
    'https://management.azure.com:8443/subscriptions',
    'https://management.azure.com.evil.example/',
    'https://evil.example/?https://management.azure.com',
    'https://user:pass@management.azure.com/',
    'https://login.microsoftonline.com/',
  ])('blocks %s', (url) => {
    expect(findAllowedEndpoint(new URL(url))).toBeUndefined();
  });
});
