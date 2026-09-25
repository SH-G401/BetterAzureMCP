import type { ArmClient } from './armClient.js';
import type { AzureHttp } from './http.js';
import { ToolInputError } from './errors.js';
import { parseResourceId, type ParsedResourceId } from './resourceId.js';

export const WEB_API_VERSION = '2023-12-01';

export interface Site {
  id: string;
  name: string;
  kind?: string;
  location: string;
  properties: {
    state?: string;
    enabled?: boolean;
    hostNameSslStates?: { name: string; hostType?: string }[];
    enabledHostNames?: string[];
    serverFarmId?: string;
    [key: string]: unknown;
  };
}

export function parseSiteId(resourceId: string): ParsedResourceId {
  const resource = parseResourceId(resourceId);
  const type = resource.type.toLowerCase();
  if (type !== 'microsoft.web/sites' && type !== 'microsoft.web/sites/slots') {
    throw new ToolInputError(
      `${resourceId} is not an App Service or Function app (Microsoft.Web/sites or Microsoft.Web/sites/slots).`,
    );
  }
  return resource;
}

export function getSite(arm: ArmClient, resourceId: string, signal?: AbortSignal): Promise<Site> {
  const resource = parseSiteId(resourceId);
  return arm.request<Site>({
    method: 'GET',
    path: resource.id,
    apiVersion: WEB_API_VERSION,
    signal,
  });
}

export function isLinux(site: Site): boolean {
  return (site.kind ?? '').toLowerCase().includes('linux');
}

/** The SCM (Kudu) host of a site, e.g. `orders-api.scm.azurewebsites.net`. */
export function scmHost(site: Site): string {
  const fromSsl = site.properties.hostNameSslStates?.find(
    (h) => h.hostType?.toLowerCase() === 'repository',
  )?.name;
  const host =
    fromSsl ?? site.properties.enabledHostNames?.find((h) => h.toLowerCase().includes('.scm.'));
  if (host === undefined) {
    throw new ToolInputError(
      `${site.name} has no Kudu (SCM) site, so its log files cannot be read. This is the case for Linux Consumption function apps. Use azure_appinsights_failures or azure_logs_query instead.`,
    );
  }
  return host.toLowerCase();
}

export interface KuduFile {
  name: string;
  size: number;
  modified: string;
  href: string;
}

/** Reads the last `lines` lines of a Kudu log file. */
export async function tailKuduFile(
  http: AzureHttp,
  href: string,
  size: number,
  lines: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const window = Math.min(Math.max(size, 1), 512 * 1024);
  const text = await http.text({
    url: href,
    headers: { Range: `bytes=-${window}` },
    signal,
  });
  const all = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  // A ranged read usually starts mid-line; drop the partial first line.
  const complete = size > window ? all.slice(1) : all;
  return complete.slice(-lines);
}
