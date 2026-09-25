import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ENDPOINTS,
  findAllowedEndpoint,
  isReadOnlyRequest,
} from '../../src/http/endpoints.js';

const SUB = '/subscriptions/00000000-0000-0000-0000-000000000001';

describe('egress allowlist', () => {
  it('is exactly the documented list of hosts', () => {
    // Changing this list changes the privacy promise. Update SECURITY.md in the same change.
    expect(ALLOWED_ENDPOINTS.map((e) => e.hosts)).toEqual([
      'management.azure.com',
      'api.loganalytics.io',
      '*.scm.azurewebsites.net',
      '*.azmk8s.io',
    ]);
  });

  it.each([
    ['https://management.azure.com/subscriptions', 'arm'],
    ['https://MANAGEMENT.AZURE.COM/providers', 'arm'],
    ['https://api.loganalytics.io/v1/workspaces/x/query', 'log-analytics'],
    ['https://orders-api.scm.azurewebsites.net/api/logs/docker', 'kudu'],
    ['https://orders-api-abc123.scm.westeurope-01.azurewebsites.net/api/logs/docker', 'kudu'],
    ['https://aks-dns-1a2b3c.hcp.westeurope.azmk8s.io:443/api/v1/pods', 'aks'],
  ])('allows %s', (url, id) => {
    expect(findAllowedEndpoint(new URL(url))?.id).toBe(id);
  });

  it.each([
    'http://management.azure.com/subscriptions',
    'https://management.azure.com:8443/subscriptions',
    'https://management.azure.com.evil.example/',
    'https://evil.example/?https://management.azure.com',
    'https://user:pass@management.azure.com/',
    'https://login.microsoftonline.com/',
    'https://orders-api.azurewebsites.net/',
    'https://scm.azurewebsites.net.evil.example/',
    'https://evil-azmk8s.io/',
    'https://api.applicationinsights.io/',
  ])('blocks %s', (url) => {
    expect(findAllowedEndpoint(new URL(url))).toBeUndefined();
  });
});

describe('read-only rules', () => {
  const allowed = (method: string, url: string) => isReadOnlyRequest(method, new URL(url));

  it('allows ARM reads and query POSTs only', () => {
    expect(allowed('GET', `https://management.azure.com${SUB}/resourceGroups/rg`)).toBe(true);
    expect(
      allowed('POST', 'https://management.azure.com/providers/Microsoft.ResourceGraph/resources'),
    ).toBe(true);
    expect(
      allowed(
        'POST',
        `https://management.azure.com${SUB}/resourceGroups/rg/providers/Microsoft.ContainerService/managedClusters/aks/listClusterUserCredential`,
      ),
    ).toBe(true);
    for (const action of [
      'listKeys',
      'listClusterAdminCredential',
      'restart',
      'runCommand',
      'config/appsettings/list',
    ]) {
      expect(
        allowed(
          'POST',
          `https://management.azure.com${SUB}/resourceGroups/rg/providers/Microsoft.Web/sites/app/${action}`,
        ),
      ).toBe(false);
    }
    expect(allowed('PUT', `https://management.azure.com${SUB}/resourceGroups/rg`)).toBe(false);
    expect(allowed('DELETE', `https://management.azure.com${SUB}/resourceGroups/rg`)).toBe(false);
  });

  it('allows Log Analytics queries only', () => {
    expect(
      allowed(
        'POST',
        'https://api.loganalytics.io/v1/workspaces/00000000-0000-0000-0000-000000000001/query',
      ),
    ).toBe(true);
    expect(
      allowed(
        'POST',
        `https://api.loganalytics.io/v1${SUB}/resourceGroups/rg/providers/Microsoft.Web/sites/app/query`,
      ),
    ).toBe(true);
    expect(allowed('POST', 'https://api.loganalytics.io/v1/workspaces/not-a-guid/query')).toBe(
      false,
    );
    expect(
      allowed(
        'POST',
        'https://api.loganalytics.io/v1/workspaces/00000000-0000-0000-0000-000000000001/search',
      ),
    ).toBe(false);
  });

  it('allows Kudu log files only', () => {
    const kudu = 'https://app.scm.azurewebsites.net';
    expect(allowed('GET', `${kudu}/api/logs/docker`)).toBe(true);
    expect(allowed('GET', `${kudu}/api/vfs/LogFiles/2026_09_25_default_docker.log`)).toBe(true);
    expect(allowed('GET', `${kudu}/api/vfs/LogFiles/Application/`)).toBe(true);
    expect(allowed('GET', `${kudu}/api/vfs/site/wwwroot/appsettings.json`)).toBe(false);
    expect(allowed('GET', `${kudu}/api/vfs/LogFiles/../site/wwwroot/web.config`)).toBe(false);
    expect(allowed('GET', `${kudu}/api/vfs/LogFiles/%2e%2e/site/wwwroot/web.config`)).toBe(false);
    expect(allowed('GET', `${kudu}/api/settings`)).toBe(false);
    expect(allowed('POST', `${kudu}/api/command`)).toBe(false);
  });

  it('allows Kubernetes status reads and pod logs only', () => {
    const k8s = 'https://aks.hcp.westeurope.azmk8s.io';
    expect(allowed('GET', `${k8s}/api/v1/pods`)).toBe(true);
    expect(allowed('GET', `${k8s}/api/v1/namespaces/default/pods/web-1/log`)).toBe(true);
    expect(allowed('GET', `${k8s}/api/v1/namespaces/default/events`)).toBe(true);
    expect(allowed('GET', `${k8s}/apis/apps/v1/namespaces/default/deployments`)).toBe(true);
    expect(allowed('GET', `${k8s}/api/v1/namespaces/default/secrets`)).toBe(false);
    expect(allowed('GET', `${k8s}/api/v1/secrets`)).toBe(false);
    expect(allowed('GET', `${k8s}/api/v1/namespaces/default/configmaps`)).toBe(false);
    expect(allowed('GET', `${k8s}/api/v1/namespaces/default/pods/web-1/exec`)).toBe(false);
    expect(allowed('GET', `${k8s}/api/v1/namespaces/default/pods/web-1/proxy`)).toBe(false);
    expect(allowed('DELETE', `${k8s}/api/v1/namespaces/default/pods/web-1`)).toBe(false);
  });
});
