import { execFileSync } from 'node:child_process';

/** Integration tests run against the real bundle, exactly as MCP clients start it. */
export default function setup(): void {
  execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'ignore' });
}
