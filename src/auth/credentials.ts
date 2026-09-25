import {
  AzureCliCredential,
  AzureDeveloperCliCredential,
  AzurePowerShellCredential,
  EnvironmentCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import type { AccessToken, TokenCredential } from '@azure/core-auth';
import type { Config, CredentialSource } from '../config.js';
import type { TokenProvider } from '../http/policies.js';
import type { Logger } from '../logger.js';
import { ARM_SCOPE } from '../http/endpoints.js';

/**
 * Credential handling is deliberately non-interactive. The official Azure MCP server can
 * fall back to a browser login that blocks a tool call for up to five minutes. Here, a
 * missing login fails immediately with instructions instead.
 */

export interface NamedCredential {
  readonly source: Exclude<CredentialSource, 'auto'>;
  readonly label: string;
  readonly credential: TokenCredential;
}

export class NotSignedInError extends Error {
  override name = 'NotSignedInError';
  constructor(readonly attempts: readonly CredentialAttempt[]) {
    super(describeAttempts(attempts));
  }
}

export interface CredentialAttempt {
  label: string;
  error: string;
}

export type AuthStatus =
  | { state: 'unknown' }
  | { state: 'ok'; source: string }
  | { state: 'failed'; attempts: readonly CredentialAttempt[] };

const PROCESS_TIMEOUT_MS = 20_000;
/** Tokens are refreshed this long before they expire. */
const EXPIRY_MARGIN_MS = 5 * 60_000;

export function createCredentialChain(config: Config): NamedCredential[] {
  const tenantId = config.tenantId;
  const all: Record<NamedCredential['source'], () => NamedCredential> = {
    environment: () => ({
      source: 'environment',
      label: 'Environment variables (AZURE_CLIENT_ID, ...)',
      credential: new EnvironmentCredential(),
    }),
    azurecli: () => ({
      source: 'azurecli',
      label: 'Azure CLI (az login)',
      credential: new AzureCliCredential({ tenantId, processTimeoutInMs: PROCESS_TIMEOUT_MS }),
    }),
    azd: () => ({
      source: 'azd',
      label: 'Azure Developer CLI (azd auth login)',
      credential: new AzureDeveloperCliCredential({
        tenantId,
        processTimeoutInMs: PROCESS_TIMEOUT_MS,
      }),
    }),
    azurepowershell: () => ({
      source: 'azurepowershell',
      label: 'Azure PowerShell (Connect-AzAccount)',
      credential: new AzurePowerShellCredential({
        tenantId,
        processTimeoutInMs: PROCESS_TIMEOUT_MS,
      }),
    }),
    managedidentity: () => ({
      source: 'managedidentity',
      label: 'Managed identity',
      credential: new ManagedIdentityCredential(),
    }),
  };

  if (config.credential !== 'auto') {
    return [all[config.credential]()];
  }
  // Managed identity is opt-in: probing the metadata endpoint is slow on developer machines.
  return [all.environment(), all.azurecli(), all.azd(), all.azurepowershell()];
}

/**
 * Hands out access tokens from the first credential in the chain that works, remembers that
 * credential, and caches tokens until shortly before they expire. Concurrent requests for
 * the same scope share one token acquisition.
 */
export class CredentialManager implements TokenProvider {
  private selected: NamedCredential | undefined;
  private status: AuthStatus = { state: 'unknown' };
  private readonly cache = new Map<string, AccessToken>();
  private readonly pending = new Map<string, Promise<AccessToken>>();

  constructor(
    private readonly chain: readonly NamedCredential[],
    private readonly logger: Logger,
  ) {}

  getStatus(): AuthStatus {
    return this.status;
  }

  async getToken(scope: string, signal?: AbortSignal): Promise<string> {
    return (await this.getAccessToken(scope, signal)).token;
  }

  async getAccessToken(scope: string, signal?: AbortSignal): Promise<AccessToken> {
    const cached = this.cache.get(scope);
    if (cached !== undefined && cached.expiresOnTimestamp - EXPIRY_MARGIN_MS > Date.now()) {
      return cached;
    }
    let inflight = this.pending.get(scope);
    if (inflight === undefined) {
      inflight = this.acquire(scope).finally(() => this.pending.delete(scope));
      this.pending.set(scope, inflight);
    }
    return signal === undefined ? inflight : raceAbort(inflight, signal);
  }

  /** Resolves a credential in the background so the first tool call does not pay for it. */
  prewarm(): void {
    this.getAccessToken(ARM_SCOPE).then(
      () => {
        this.logger.info(`Signed in to Azure via ${this.selected?.label ?? 'unknown'}.`);
      },
      () => {
        this.logger.warn(
          'Not signed in to Azure yet. Tools will explain how to sign in; run "betterazuremcp doctor" for details.',
        );
      },
    );
  }

  private async acquire(scope: string): Promise<AccessToken> {
    // Try the credential that worked last time first, then the rest of the chain.
    const previous = this.selected;
    const candidates = previous
      ? [previous, ...this.chain.filter((c) => c !== previous)]
      : this.chain;
    const attempts: CredentialAttempt[] = [];

    for (const candidate of candidates) {
      try {
        const token = await candidate.credential.getToken(scope);
        if (token === null) throw new Error('No token returned.');
        this.selected = candidate;
        this.status = { state: 'ok', source: candidate.label };
        this.cache.set(scope, token);
        return token;
      } catch (error) {
        const message = conciseError(error instanceof Error ? error.message : String(error));
        this.logger.debug(`${candidate.label}: ${message}`);
        attempts.push({ label: candidate.label, error: message });
      }
    }

    this.selected = undefined;
    this.status = { state: 'failed', attempts };
    throw new NotSignedInError(attempts);
  }
}

function describeAttempts(attempts: readonly CredentialAttempt[]): string {
  const lines = attempts.map((a) => `  - ${a.label}: ${a.error}`);
  return [
    'Not signed in to Azure. Tried:',
    ...lines,
    'Fix: run "az login" (or "azd auth login") in a terminal, then retry. No restart needed.',
    'Use BETTERAZUREMCP_TENANT_ID to select a tenant.',
  ].join('\n');
}

/** Keeps the first line of an SDK error and drops "see this link" boilerplate. */
export function conciseError(text: string): string {
  const line = (text.split('\n').find((l) => l.trim() !== '') ?? text).trim();
  const sentences = line
    .replace(/^Error:\s*/, '')
    .split(/(?<=\.)\s+/)
    .filter((sentence) => !/https?:\/\/|troubleshoot/i.test(sentence));
  const result = sentences.join(' ').trim();
  return (result === '' ? line : result).slice(0, 300);
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted.');
}
