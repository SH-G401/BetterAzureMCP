import { isRestError } from '@azure/core-rest-pipeline';
import { NotSignedInError } from '../auth/credentials.js';
import { PolicyViolationError } from '../http/policies.js';

/** An error response from an Azure API, with the parts that help a developer act on it. */
export class AzureApiError extends Error {
  override name = 'AzureApiError';
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly azureMessage: string,
    readonly requestId: string | undefined,
  ) {
    super(`${status}${code ? ` ${code}` : ''}: ${azureMessage}`);
  }
}

export class ToolInputError extends Error {
  override name = 'ToolInputError';
}

export class ToolTimeoutError extends Error {
  override name = 'ToolTimeoutError';
}

/** Turns any failure into a message that says what went wrong and what to do about it. */
export function describeError(error: unknown): string {
  if (error instanceof NotSignedInError) return error.message;
  if (error instanceof ToolInputError) return `Invalid input: ${error.message}`;
  if (error instanceof ToolTimeoutError) return error.message;
  if (error instanceof PolicyViolationError) return error.message;
  if (error instanceof AzureApiError) return describeApiError(error);
  if (isRestError(error) && error.statusCode === undefined) {
    return [
      `Could not reach Azure: ${error.message}`,
      'Check your network connection. Behind a proxy, set HTTPS_PROXY (and NO_PROXY if needed).',
    ].join('\n');
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return 'The request was cancelled.';
  }
  return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}

function describeApiError(error: AzureApiError): string {
  const lines = [`Azure returned ${error.message}`];
  const hint = hintFor(error);
  if (hint) lines.push(hint);
  if (error.requestId) lines.push(`Request ID: ${error.requestId}`);
  return lines.join('\n');
}

function hintFor(error: AzureApiError): string | undefined {
  const code = error.code?.toLowerCase() ?? '';
  switch (error.status) {
    case 401:
      return 'The sign-in was rejected or has expired. Run "az login" and retry. If you use several tenants, set BETTERAZUREMCP_TENANT_ID.';
    case 403:
      return 'Your account lacks permission for this. Read access usually requires the "Reader" role on the subscription, resource group or resource.';
    case 404:
      if (code.includes('subscription')) {
        return 'Check the subscription ID. Use azure_context to list the subscriptions you can access.';
      }
      return 'The resource does not exist or is not visible to your account. Use azure_find_resources to look up the exact resource ID.';
    case 429:
      return 'Azure is throttling requests. Wait a moment and retry with a narrower query.';
    default:
      if (code === 'invalidapiversionparameter' || code === 'noregisteredproviderfound') {
        return 'The API version is not supported for this resource type. Retry without apiVersion so the server picks a supported one.';
      }
      return undefined;
  }
}
