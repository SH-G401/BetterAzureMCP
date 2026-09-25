/** Identity details read from an access token. Used for display only, never for authorization. */
export interface TokenIdentity {
  tenantId?: string;
  objectId?: string;
  /** User principal name, e-mail or application ID, whichever the token carries. */
  principal?: string;
  principalType?: 'user' | 'app';
}

export function readTokenIdentity(token: string): TokenIdentity {
  const payload = token.split('.')[1];
  if (payload === undefined) return {};
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
  const str = (key: string): string | undefined =>
    typeof claims[key] === 'string' ? claims[key] : undefined;

  const principal = str('upn') ?? str('unique_name') ?? str('email') ?? str('appid');
  const isApp = str('idtyp') === 'app' || (str('upn') === undefined && str('appid') !== undefined);
  return {
    tenantId: str('tid'),
    objectId: str('oid'),
    principal,
    principalType: isApp ? 'app' : 'user',
  };
}
