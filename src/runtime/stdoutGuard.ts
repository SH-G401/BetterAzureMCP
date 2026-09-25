import { Writable } from 'node:stream';

/**
 * In stdio mode, stdout carries the MCP JSON-RPC stream and nothing else. A single stray
 * byte from any dependency corrupts the stream and the client drops the connection.
 *
 * `installStdoutGuard` captures the real stdout for the protocol and redirects every other
 * writer (`console.log`, `process.stdout.write`, ...) to stderr, where clients show it as logs.
 */
export function installStdoutGuard(): Writable {
  const stdout = process.stdout;
  const writeToStdout = stdout.write.bind(stdout);
  const writeToStderr = process.stderr.write.bind(process.stderr);

  stdout.write = writeToStderr;

  /* eslint-disable no-console */
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  console.warn = console.error;
  console.trace = console.error;
  /* eslint-enable no-console */

  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      writeToStdout(chunk, (error?: Error | null) => {
        callback(error ?? null);
      });
    },
  });
}
