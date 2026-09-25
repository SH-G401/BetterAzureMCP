export const REDACTED = '[redacted]';

/** Property names whose string values are treated as secrets. Matched on the end of the name. */
const SECRET_KEY =
  /(password|passwd|pwd|secret|key|keys|token|connectionstring|sas|signature|credential|credentials)$/i;

/** Names that end like a secret but are not one. */
const NOT_SECRET_KEYS = new Set([
  'partitionkey',
  'rowkey',
  'publickey',
  'sshpublickey',
  'keytype',
  'keysource',
  'tokentype',
]);

/** Values that look like secrets regardless of the property name. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /(AccountKey|SharedAccessKey|SharedAccessSignature|Password|Pwd|ClientSecret)\s*=/i,
  /[?&]sig=[^&\s]+/i,
  /^eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*$/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/**
 * Returns a deep copy with secret-looking values replaced. Property names are kept, so the
 * model can still see that a setting exists.
 */
export function redactSecrets(value: unknown): unknown {
  return redact(value, undefined);
}

function redact(value: unknown, key: string | undefined): unknown {
  if (key !== undefined && isSecretKey(key) && value !== null && typeof value === 'object') {
    // e.g. a change record { "properties.adminPassword": { previousValue, newValue } }
    return maskAllStrings(value);
  }
  if (typeof value === 'string') {
    if (key !== undefined && isSecretKey(key) && value !== '') return REDACTED;
    return SECRET_VALUE_PATTERNS.some((p) => p.test(value)) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactArrayItem(item, key));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k);
    return out;
  }
  return value;
}

function maskAllStrings(value: unknown): unknown {
  if (typeof value === 'string') return value === '' ? value : REDACTED;
  if (Array.isArray(value)) return value.map(maskAllStrings);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskAllStrings(v);
    return out;
  }
  return value;
}

/**
 * Handles `[{ name: "DB_PASSWORD", value: "..." }]`, the shape Azure uses for app settings,
 * environment variables and connection strings.
 */
function redactArrayItem(item: unknown, parentKey: string | undefined): unknown {
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    const record = item as Record<string, unknown>;
    const name = record.name;
    if (typeof name === 'string' && isSecretKey(name) && typeof record.value === 'string') {
      return { ...(redact(record, undefined) as object), value: REDACTED };
    }
  }
  return redact(item, parentKey === undefined ? undefined : `${parentKey}[]`);
}

function isSecretKey(key: string): boolean {
  const normalized = key.replace(/\[\]$/, '').replace(/[^a-z0-9]/gi, '');
  if (NOT_SECRET_KEYS.has(normalized.toLowerCase())) return false;
  return SECRET_KEY.test(normalized);
}
