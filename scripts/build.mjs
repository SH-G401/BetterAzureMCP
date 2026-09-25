// Bundles the server into a single self-contained ESM file with no runtime dependencies.
import { build } from 'esbuild';
import { chmod, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const outfile = 'dist/betterazuremcp.mjs';
const legalFile = `${outfile}.LEGAL.txt`;
const noticesFile = 'dist/THIRD_PARTY_NOTICES.txt';

/**
 * Packages that a dependency copied into its own published code, so they have no directory in
 * node_modules. Check with the dependency's source map when upgrading it.
 */
const INLINED = [
  {
    name: 'content-type',
    license: 'MIT',
    copyright: 'Copyright (c) 2015 Douglas Christopher Wilson',
    via: '@modelcontextprotocol/server',
  },
];

const result = await build({
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
  metafile: true,
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
await writeNotices(result.metafile);

/**
 * The bundle contains code from third-party packages whose licenses require their copyright
 * and license notices to travel with every copy. This collects the full license text of each
 * bundled package, plus the license comments esbuild extracted from the code, into one file.
 */
async function writeNotices(metafile) {
  const roots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input.replaceAll('\\', '/'));
    if (match) roots.add(match[1]);
  }

  const packages = [];
  const missing = [];
  for (const root of roots) {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const licenseFile = (await readdir(root)).find((name) => /^licen[cs]e(\.|$)/i.test(name));
    if (licenseFile === undefined) {
      missing.push(manifest.name);
      continue;
    }
    const text = (await readFile(path.join(root, licenseFile), 'utf8')).trim();
    packages.push({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      text,
    });
  }
  if (missing.length > 0) {
    throw new Error(`No license file found for bundled packages: ${missing.join(', ')}`);
  }
  // The MIT permission notice is the same for every package; take it from our own LICENSE.
  const mitNotice = (await readFile('LICENSE', 'utf8')).replace(/^[\s\S]*?\n(?=Permission)/, '');
  for (const p of INLINED) {
    packages.push({
      name: p.name,
      license: `${p.license}, included in ${p.via}`,
      text: `The MIT License\n\n${p.copyright}\n\n${mitNotice.trim()}`,
    });
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));

  const rule = '-'.repeat(78);
  const sections = packages.map((p) =>
    [
      rule,
      `${[p.name, p.version].filter(Boolean).join(' ')} (${p.license})`,
      rule,
      '',
      p.text,
      '',
    ].join('\n'),
  );
  const legalComments = (await readFile(legalFile, 'utf8').catch(() => '')).trim();
  await rm(legalFile, { force: true });

  const header = [
    `${pkg.name} ${pkg.version} is distributed as a single file that includes code from the`,
    `following ${packages.length} open-source packages. Their copyright and license notices follow.`,
    '',
  ].join('\n');
  const footer =
    legalComments === ''
      ? []
      : [rule, 'License comments found in the bundled code', rule, '', legalComments, ''];
  await writeFile(noticesFile, [header, ...sections, ...footer].join('\n'));
  console.log(`Wrote ${noticesFile} (${packages.length} packages).`);
}
