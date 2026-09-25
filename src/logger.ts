export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface Logger {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

/** Logs to stderr only. stdout is reserved for the MCP protocol. */
export function createLogger(level: LogLevel, write: (line: string) => void = stderrWrite): Logger {
  const threshold = LEVELS[level];
  const log = (lvl: LogLevel, message: string): void => {
    if (LEVELS[lvl] <= threshold) {
      write(`${new Date().toISOString()} [${lvl}] ${message}\n`);
    }
  };
  return {
    error: (m) => {
      log('error', m);
    },
    warn: (m) => {
      log('warn', m);
    },
    info: (m) => {
      log('info', m);
    },
    debug: (m) => {
      log('debug', m);
    },
  };
}

function stderrWrite(line: string): void {
  process.stderr.write(line);
}

export const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
};
