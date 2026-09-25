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
import { readTokenIdentity } from './tokenClaims.js';

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

export type CredentialChainFactory = (tenantId: string | undefined) => readonly NamedCredential[];

export function createCredentialChain(
  config: Config,
  tenantId: string | undefined = config.tenantId,
): NamedCredential[] {
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
  private readonly factory: CredentialChainFactory;
  private chain: readonly NamedCredential[];
  private tenant: TenantChoice | undefined;

  /**
   * @param chain The credentials to try, or a factory that builds them for a tenant.
   * @param tenant The directory to sign in to. A `remembered` tenant (from an earlier session)
   *   is dropped in favour of the default login when no credential can use it.
   * @param onRememberedTenantRejected Called when that happens.
   */
  constructor(
    chain: readonly NamedCredential[] | CredentialChainFactory,
    private readonly logger: Logger,
    tenant?: TenantChoice,
    private readonly onRememberedTenantRejected?: () => void,
  ) {
    this.factory = typeof chain === 'function' ? chain : () => chain;
    this.tenant = tenant;
    this.chain = this.factory(tenant?.id);
  }

  getStatus(): AuthStatus {
    return this.status;
  }

  /** The directory tokens are requested for, when one was chosen explicitly or remembered. */
  getTenantId(): string | undefined {
    return this.tenant?.id;
  }

  /** The directory of the current Azure Resource Manager token, if one is cached. */
  cachedTenantId(): string | undefined {
    const token = this.cache.get(ARM_SCOPE);
    return token === undefined ? undefined : readTokenIdentity(token.token).tenantId;
  }

  /** Switches to another directory (or back to the default login with `undefined`). */
  useTenant(tenantId: string | undefined): void {
    this.tenant = tenantId === undefined ? undefined : { id: tenantId, remembered: false };
    this.reset();
  }

  private reset(): void {
    this.chain = this.factory(this.tenant?.id);
    this.selected = undefined;
    this.cache.clear();
    this.pending.clear();
    this.status = { state: 'unknown' };
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

    if (this.tenant?.remembered) {
      // The directory remembered from an earlier session may no longer fit this login (for
      // example, a different account is signed in). Try the default directory, and forget the
      // remembered one only if that works: when nothing works, the user is simply not signed
      // in and the memory is kept.
      const remembered = this.tenant;
      this.tenant = undefined;
      this.reset();
      try {
        const token = await this.acquire(scope);
        this.logger.info(
          `The remembered directory ${remembered.id} is not available for this login; using the default directory.`,
        );
        this.onRememberedTenantRejected?.();
        return token;
      } catch {
        this.tenant = remembered;
        this.reset();
      }
    }

    this.selected = undefined;
    this.status = { state: 'failed', attempts };
    throw new NotSignedInError(attempts);
  }
}

export interface TenantChoice {
  id: string;
  /** True when the tenant comes from an earlier session rather than from configuration. */
  remembered: boolean;
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
