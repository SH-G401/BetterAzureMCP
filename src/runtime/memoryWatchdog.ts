import type { Logger } from '../logger.js';

export interface WatchdogOptions {
  limitBytes: number;
  logger: Logger;
  /** Called when the limit is exceeded. Defaults to exiting the process. */
  onExceeded?: () => void;
  readRss?: () => number;
  intervalMs?: number;
}

/**
 * Stops the server if its memory ever exceeds a hard limit (BETTERAZUREMCP_MAX_MEMORY_MB).
 * A bug should cost a server restart, never a frozen machine: the official Azure MCP server
 * has been reported growing to 84 GB. The MCP client starts the server again on the next call.
 */
export function startMemoryWatchdog(options: WatchdogOptions): () => void {
  const readRss = options.readRss ?? (() => process.memoryUsage.rss());
  const onExceeded =
    options.onExceeded ??
    (() => {
      process.exit(1);
    });

  const check = (): void => {
    const rss = readRss();
    if (rss > options.limitBytes) {
      options.logger.error(
        `Memory use of ${mb(rss)} MB exceeded the limit of ${mb(options.limitBytes)} MB (BETTERAZUREMCP_MAX_MEMORY_MB). Stopping; the client will restart the server. Please report this at https://github.com/SH-G401/BetterAzureMCP/issues.`,
      );
      onExceeded();
    }
  };

  const timer = setInterval(check, options.intervalMs ?? 15_000);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}

function mb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}
