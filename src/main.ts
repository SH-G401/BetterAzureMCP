import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { SERVER_NAME, VERSION } from './version.js';

const HELP = `${SERVER_NAME} ${VERSION}
Read-only Azure MCP server for debugging Azure applications.

Usage:
  ${SERVER_NAME}            Start the MCP server on stdio (what MCP clients run)
  ${SERVER_NAME} doctor     Check sign-in, permissions and connectivity
  ${SERVER_NAME} --version  Print the version
  ${SERVER_NAME} --help     Print this help

Configuration (environment variables):
  BETTERAZUREMCP_TENANT_ID         Tenant to sign in to (default: tenant of your login)
  BETTERAZUREMCP_CREDENTIAL        auto | azurecli | azd | azurepowershell | environment | managedidentity
  BETTERAZUREMCP_TIMEOUT_SECONDS   Deadline per tool call (default 60)
  BETTERAZUREMCP_MAX_RESPONSE_KB   Size limit per tool result (default 12)
  BETTERAZUREMCP_SUBSCRIPTIONS     Comma-separated subscription IDs; the server reads only these
  BETTERAZUREMCP_MAX_MEMORY_MB     Stop the server if it ever uses more memory (default 1024)
  BETTERAZUREMCP_REMEMBER_CONTEXT  Remember the last-used subscription and directory (default true)
  BETTERAZUREMCP_STATE_DIR         Where to keep that memory (default: per-user app data folder)
  BETTERAZUREMCP_SHOW_SECRETS      Set to true to disable masking of secret values
  BETTERAZUREMCP_LOG_LEVEL         error | warn | info | debug (default info)

Sign in first with "az login" (or "azd auth login").
`;

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? 'serve';
  const out = (text: string): void => {
    process.stdout.write(text);
  };

  switch (command) {
    case '--version':
    case '-v':
      out(`${VERSION}\n`);
      return 0;
    case '--help':
    case '-h':
    case 'help':
      out(HELP);
      return 0;
    case 'serve':
      return serve();
    case 'doctor': {
      const config = loadConfig();
      const { createAzureServices } = await import('./services.js');
      const { runDoctor } = await import('./doctor.js');
      const services = createAzureServices(config, createLogger('error'));
      return runDoctor(services, out);
    }
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

async function serve(): Promise<number> {
  // Must run before anything else can write to stdout.
  const { installStdoutGuard } = await import('./runtime/stdoutGuard.js');
  const protocolOut = installStdoutGuard();

  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  process.on('unhandledRejection', (reason) => {
    logger.error(
      `Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    );
  });
  process.on('uncaughtException', (error) => {
    // Staying up keeps the client connected; every request is independent.
    logger.error(`Uncaught exception: ${error.stack ?? error.message}`);
  });

  const [{ serveStdio, StdioServerTransport }, { createAzureServices }, { createMcpServer }] =
    await Promise.all([
      import('@modelcontextprotocol/server/stdio'),
      import('./services.js'),
      import('./server.js'),
    ]);

  const services = createAzureServices(config, logger);
  services.credentials.prewarm();
  const { startMemoryWatchdog } = await import('./runtime/memoryWatchdog.js');
  startMemoryWatchdog({ limitBytes: config.maxMemoryBytes, logger });

  const handle = serveStdio(() => createMcpServer(services, logger), {
    transport: new StdioServerTransport(process.stdin, protocolOut),
    onerror: (error) => {
      logger.error(`Protocol error: ${error.message}`);
    },
  });

  const shutdown = (): void => {
    void handle.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdin.once('end', shutdown);

  logger.info(`${SERVER_NAME} ${VERSION} ready (read-only, stdio).`);
  // Keep running until the client disconnects; the transport holds the process open.
  return new Promise<number>(() => undefined);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message =
      error instanceof ConfigError
        ? `Configuration error: ${error.message}`
        : `Fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  },
);
