import { describe, expect, it, vi } from 'vitest';
import { conciseError, CredentialManager, NotSignedInError } from '../../src/auth/credentials.js';
import { readTokenIdentity } from '../../src/auth/tokenClaims.js';
import { silentLogger } from '../../src/logger.js';
import { fakeCredential, fakeToken } from '../helpers.js';

const SCOPE = 'https://management.azure.com/.default';
const unavailable = () => Promise.reject(new Error('Azure CLI could not be found.'));

describe('CredentialManager', () => {
  it('uses the first credential that works and reports it', async () => {
    const cli = vi.fn(unavailable);
    const azd = vi.fn(() => Promise.resolve(fakeToken()));
    const manager = new CredentialManager(
      [fakeCredential('azurecli', cli), fakeCredential('azd', azd)],
      silentLogger,
    );

    await manager.getToken(SCOPE);
    expect(manager.getStatus()).toEqual({ state: 'ok', source: 'fake azd' });
  });

  it('caches tokens per scope until shortly before expiry', async () => {
    const getToken = vi.fn(() => Promise.resolve(fakeToken()));
    const manager = new CredentialManager([fakeCredential('azurecli', getToken)], silentLogger);

    await manager.getToken(SCOPE);
    await manager.getToken(SCOPE);
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('refreshes tokens that are about to expire', async () => {
    const getToken = vi.fn(() => Promise.resolve(fakeToken({}, 60_000)));
    const manager = new CredentialManager([fakeCredential('azurecli', getToken)], silentLogger);

    await manager.getToken(SCOPE);
    await manager.getToken(SCOPE);
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it('shares one acquisition between concurrent callers', async () => {
    const getToken = vi.fn(() => Promise.resolve(fakeToken()));
    const manager = new CredentialManager([fakeCredential('azurecli', getToken)], silentLogger);

    await Promise.all([manager.getToken(SCOPE), manager.getToken(SCOPE), manager.getToken(SCOPE)]);
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('falls back to the rest of the chain when the remembered credential stops working', async () => {
    let cliWorks = true;
    const cli = vi.fn(() => (cliWorks ? Promise.resolve(fakeToken({}, 1)) : unavailable()));
    const azd = vi.fn(() => Promise.resolve(fakeToken()));
    const manager = new CredentialManager(
      [fakeCredential('azurecli', cli), fakeCredential('azd', azd)],
      silentLogger,
    );

    await manager.getToken(SCOPE);
    cliWorks = false;
    await manager.getToken(SCOPE);
    expect(manager.getStatus()).toEqual({ state: 'ok', source: 'fake azd' });
  });

  it('fails immediately with instructions when nothing works', async () => {
    const manager = new CredentialManager(
      [fakeCredential('azurecli', unavailable), fakeCredential('azd', unavailable)],
      silentLogger,
    );

    const error = await manager.getToken(SCOPE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotSignedInError);
    expect((error as Error).message).toContain('az login');
    expect((error as NotSignedInError).attempts).toHaveLength(2);
    expect(manager.getStatus().state).toBe('failed');
  });

  it('stops waiting when the caller aborts', async () => {
    const manager = new CredentialManager(
      [fakeCredential('azurecli', () => new Promise(() => undefined))],
      silentLogger,
    );
    const controller = new AbortController();
    const pending = manager.getToken(SCOPE, controller.signal);
    controller.abort(new Error('deadline'));
    await expect(pending).rejects.toThrow('deadline');
  });
});

describe('conciseError', () => {
  it('drops links and troubleshooting boilerplate', () => {
    expect(
      conciseError(
        'Azure CLI could not be found. Please visit https://aka.ms/azure-cli for installation instructions.\nstack',
      ),
    ).toBe('Azure CLI could not be found.');
    expect(conciseError('Error: Unable to execute PowerShell. To troubleshoot, visit x.')).toBe(
      'Unable to execute PowerShell.',
    );
  });
});

describe('readTokenIdentity', () => {
  it('reads user tokens', () => {
    expect(readTokenIdentity(fakeToken().token)).toEqual({
      tenantId: 'tenant-1',
      objectId: 'oid-1',
      principal: 'dev@contoso.com',
      principalType: 'user',
    });
  });

  it('reads app tokens', () => {
    const token = fakeToken({ upn: undefined, appid: 'app-1', idtyp: 'app' }).token;
    expect(readTokenIdentity(token)).toMatchObject({ principal: 'app-1', principalType: 'app' });
  });

  it('returns nothing for malformed tokens', () => {
    expect(readTokenIdentity('not-a-jwt')).toEqual({});
    expect(readTokenIdentity('a.!!!.c')).toEqual({});
  });
});
