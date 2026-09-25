import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import type { Logger } from '../logger.js';

/** The subscription and directory (Entra tenant) the user worked in most recently. */
export interface RememberedContext {
  subscriptionId?: string;
  subscriptionName?: string;
  tenantId?: string;
  tenantName?: string;
  updatedAt?: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_NAME = 'context.json';

/**
 * Remembers the most recently used subscription and directory across sessions, so the
 * assistant does not have to ask where to look every time. Stored in a small local file;
 * nothing leaves the machine. Without a file path, the store only lives in memory.
 */
export class ContextStore {
  private value: RememberedContext;

  constructor(
    readonly filePath: string | undefined,
    private readonly logger: Logger,
  ) {
    this.value = filePath === undefined ? {} : this.load(filePath);
  }

  get(): RememberedContext {
    return { ...this.value };
  }

  /** Merges `update` into the remembered context and saves it when something changed. */
  remember(update: RememberedContext): void {
    const merged: RememberedContext = { ...this.value, ...update };
    // A new subscription or directory invalidates the name remembered for the old one.
    if (
      'subscriptionId' in update &&
      update.subscriptionId !== this.value.subscriptionId &&
      !('subscriptionName' in update)
    ) {
      delete merged.subscriptionName;
    }
    if (
      'tenantId' in update &&
      update.tenantId !== this.value.tenantId &&
      !('tenantName' in update)
    ) {
      delete merged.tenantName;
    }
    const next = sanitize(merged);
    const changed = (Object.keys(next) as (keyof RememberedContext)[]).some(
      (key) => key !== 'updatedAt' && next[key] !== this.value[key],
    );
    const removed = (Object.keys(this.value) as (keyof RememberedContext)[]).some(
      (key) => key !== 'updatedAt' && next[key] === undefined,
    );
    if (!changed && !removed) return;
    this.value = { ...next, updatedAt: new Date().toISOString() };
    this.save();
  }

  clear(): void {
    if (Object.keys(this.value).length === 0) return;
    this.value = {};
    this.save();
  }

  private load(file: string): RememberedContext {
    try {
      return sanitize(JSON.parse(readFileSync(file, 'utf8')) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.debug(`Ignoring unreadable context file ${file}: ${String(error)}`);
      }
      return {};
    }
  }

  private save(): void {
    if (this.filePath === undefined) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      // Write to a temporary file first, so a crash never leaves a half-written file.
      const temp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.value, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, this.filePath);
    } catch (error) {
      this.logger.warn(`Could not save the current context to ${this.filePath}: ${String(error)}`);
    }
  }
}

/** Keeps only well-formed fields, so a hand-edited or corrupt file cannot inject anything. */
function sanitize(raw: unknown): RememberedContext {
  if (raw === null || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const id = (v: unknown) =>
    typeof v === 'string' && GUID.test(v.toLowerCase()) ? v.toLowerCase() : undefined;
  const text = (v: unknown) =>
    typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\r\n<>]/.test(v) ? v : undefined;
  const out: RememberedContext = {
    subscriptionId: id(r.subscriptionId),
    subscriptionName: text(r.subscriptionName),
    tenantId: id(r.tenantId),
    tenantName: text(r.tenantName),
    updatedAt: text(r.updatedAt),
  };
  // A name without its ID means nothing.
  if (out.subscriptionId === undefined) delete out.subscriptionName;
  if (out.tenantId === undefined) delete out.tenantName;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

/**
 * Where the context file lives: BETTERAZUREMCP_STATE_DIR, or the platform's per-user
 * application data directory.
 */
export function defaultStateFile(
  stateDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (stateDir !== undefined) return join(stateDir, FILE_NAME);
  // Use the target platform's path rules, not the host's.
  if (platform === 'win32') {
    const base = env.APPDATA ?? win32.join(home, 'AppData', 'Roaming');
    return win32.join(base, 'betterazuremcp', FILE_NAME);
  }
  if (platform === 'darwin') {
    return posix.join(home, 'Library', 'Application Support', 'betterazuremcp', FILE_NAME);
  }
  const base = env.XDG_STATE_HOME ?? posix.join(home, '.local', 'state');
  return posix.join(base, 'betterazuremcp', FILE_NAME);
}
