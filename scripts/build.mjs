// Bundles the server into a single self-contained ESM file with no runtime dependencies.
import { build } from 'esbuild';
import { chmod, readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const outfile = 'dist/betterazuremcp.mjs';

await build({
  entryPoints: ['src/main.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  keepNames: true,
  sourcemap: false,
  legalComments: 'external',
  define: { __VERSION__: JSON.stringify(pkg.version) },
  banner: {
    // Some bundled dependencies are CommonJS and expect `require` to exist.
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});

await chmod(outfile, 0o755);
