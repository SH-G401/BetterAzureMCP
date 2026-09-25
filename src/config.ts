import type { LogLevel } from './logger.js';

export const CREDENTIAL_SOURCES = [
  'auto',
  'azurecli',
  'azd',
  'azurepowershell',
  'environment',
  'managedidentity',
] as const;

export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

export interface Config {
  /** Entra tenant to authenticate against. Defaults to the tenant of the active login. */
  tenantId: string | undefined;
  /** Which credential to use. `auto` tries environment, Azure CLI, azd and Azure PowerShell. */
  credential: CredentialSource;
  /** Hard deadline for a single tool call. */
  timeoutMs: number;
  /** Upper bound for the text returned by a single tool call. */
  maxResponseBytes: number;
  /** When false (default), secret-looking values are masked before they leave the server. */
  showSecrets: boolean;
  /**
   * When set, the server only reads from these subscriptions (lower-case IDs). Enforced in the
   * HTTP pipeline, so no tool can reach another subscription.
   */
  subscriptions: readonly string[] | undefined;
  /** The server stops itself if its resident memory exceeds this. */
  maxMemoryBytes: number;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const ENV_PREFIX = 'BETTERAZUREMCP_';

/** Reads configuration from environment variables. Invalid values fail fast with a clear message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const read = (key: string): string | undefined => {
    const value = env[ENV_PREFIX + key]?.trim();
    return value === '' ? undefined : value;
  };

  return {
    tenantId: read('TENANT_ID'),
    credential: parseEnum('CREDENTIAL', read('CREDENTIAL'), CREDENTIAL_SOURCES, 'auto'),
    timeoutMs: parseInteger('TIMEOUT_SECONDS', read('TIMEOUT_SECONDS'), 60, 5, 600) * 1000,
    maxResponseBytes: parseInteger('MAX_RESPONSE_KB', read('MAX_RESPONSE_KB'), 12, 2, 256) * 1024,
    showSecrets: parseBoolean('SHOW_SECRETS', read('SHOW_SECRETS'), false),
    subscriptions: parseSubscriptions('SUBSCRIPTIONS', read('SUBSCRIPTIONS')),
    maxMemoryBytes:
      parseInteger('MAX_MEMORY_MB', read('MAX_MEMORY_MB'), 1024, 256, 16_384) * 1024 * 1024,
    logLevel: parseEnum('LOG_LEVEL', read('LOG_LEVEL'), ['error', 'warn', 'info', 'debug'], 'info'),
  };
}

function parseEnum<T extends string>(
  key: string,
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  const match = allowed.find((option) => option === value.toLowerCase());
  if (match === undefined) {
    throw new ConfigError(`${ENV_PREFIX}${key} must be one of: ${allowed.join(', ')}.`);
  }
  return match;
}

function parseInteger(
  key: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${ENV_PREFIX}${key} must be a whole number from ${min} to ${max}.`);
  }
  return parsed;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseSubscriptions(key: string, value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const ids = value
    .split(/[\s,;]+/)
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id !== '');
  const invalid = ids.filter((id) => !GUID.test(id));
  if (ids.length === 0 || invalid.length > 0) {
    throw new ConfigError(
      `${ENV_PREFIX}${key} must be a comma-separated list of subscription IDs (GUIDs).${invalid.length ? ` Not valid: ${invalid.join(', ')}.` : ''}`,
    );
  }
  return [...new Set(ids)];
}

function parseBoolean(key: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false;
  throw new ConfigError(`${ENV_PREFIX}${key} must be true or false.`);
}
