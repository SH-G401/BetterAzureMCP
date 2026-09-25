import { createHttpHeaders, createPipelineRequest } from '@azure/core-rest-pipeline';
import { describe, expect, it, vi } from 'vitest';
import { createHttpStack } from '../../src/http/pipeline.js';
import { PolicyViolationError } from '../../src/http/policies.js';
import { FakeHttpClient } from '../helpers.js';

function send(method: string, url: string) {
  const http = new FakeHttpClient(() => ({ body: {} }));
  const tokens = { getToken: vi.fn(() => Promise.resolve('token-abc')) };
  const stack = createHttpStack(tokens, http);
  const request = createPipelineRequest({
    url,
    method: method as 'GET',
    headers: createHttpHeaders(),
  });
  return { result: stack.pipeline.sendRequest(stack.client, request), http, tokens };
}

describe('HTTP stack', () => {
  it('sends GET requests to ARM with a bearer token and a minimal user agent', async () => {
    const { result, http, tokens } = send('GET', 'https://management.azure.com/subscriptions');
    await expect(result).resolves.toMatchObject({ status: 200 });
    expect(tokens.getToken).toHaveBeenCalledWith(
      'https://management.azure.com/.default',
      undefined,
    );
    expect(http.requests[0]?.headers.authorization).toBe('Bearer token-abc');
    expect(http.requests[0]?.headers['user-agent']).toMatch(/^betterazuremcp\/\S+$/);
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('refuses %s without requesting a token', async (method) => {
    const { result, http, tokens } = send(method, 'https://management.azure.com/subscriptions/x');
    await expect(result).rejects.toBeInstanceOf(PolicyViolationError);
    expect(http.requests).toHaveLength(0);
    expect(tokens.getToken).not.toHaveBeenCalled();
  });

  it('refuses POST actions that are not reads', async () => {
    const { result, http } = send(
      'POST',
      'https://management.azure.com/subscriptions/s/resourceGroups/g/providers/Microsoft.Storage/storageAccounts/a/listKeys',
    );
    await expect(result).rejects.toThrow(/read-only/);
    expect(http.requests).toHaveLength(0);
  });

  it('refuses hosts outside the allowlist without requesting a token', async () => {
    const { result, http, tokens } = send('GET', 'https://example.com/');
    await expect(result).rejects.toThrow(/not on the allowlist/);
    expect(http.requests).toHaveLength(0);
    expect(tokens.getToken).not.toHaveBeenCalled();
  });
});
