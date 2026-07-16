#!/usr/bin/env bun
/**
 * 1) Bundle `src/cli.ts` to minified `dist/<bin>`.
 * 2) Pack `artifacts/spike-{version}.tar.gz` for GitHub/Homebrew.
 * 3) SHA256 that tarball and patch `Formula/spike.rb` (`version` + `sha256`).
 *
 * Fast iteration (JS only, no tarball / formula):
 *   bun run build -- --no-formula
 */
import { chmodSync, cpSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pkg from '../package.json' with { type: 'json' };

const root = fileURLToPath(new URL('..', import.meta.url));
const skipTarballAndFormula = process.argv.includes('--no-formula');
const { version } = pkg;
const distPrefix = './dist/';
const distDir = path.join(root, 'dist');
const entry = './src/cli.ts';

const binField = pkg.bin;
if (typeof binField !== 'object' || binField === null || Array.isArray(binField)) {
  throw new TypeError('package.json "bin" must be a map of command names to paths');
}
const binPath = binField['spike'];
if (typeof binPath !== 'string') {
  throw new TypeError('package.json must define bin.spike as a string');
}
if (!binPath.startsWith(distPrefix)) {
  throw new TypeError(`package.json bin.spike must start with "${distPrefix}", got "${binPath}"`);
}
const CLI_BUNDLE_NAME = binPath.slice(distPrefix.length);
const LIKE_HELPER_NAME = 'spike-like';

rmSync(distDir, { force: true, recursive: true });
mkdirSync(distDir, { recursive: true });

const cli = Bun.spawnSync(
  ['bun', 'build', entry, '--target', 'bun', '--outdir', 'dist', '--minify'],
  { cwd: root, stderr: 'inherit', stdout: 'inherit' },
);
if (cli.exitCode !== 0) {
  process.exit(cli.exitCode ?? 1);
}

const outPath = path.join(distDir, CLI_BUNDLE_NAME);
renameSync(path.join(distDir, 'cli.js'), outPath);
chmodSync(outPath, 0o755);

const likeHelper = Bun.spawnSync(
  ['swiftc', 'native/spike-like.swift', '-O', '-o', path.join('dist', LIKE_HELPER_NAME)],
  { cwd: root, stderr: 'inherit', stdout: 'inherit' },
);
if (likeHelper.exitCode !== 0) {
  process.exit(likeHelper.exitCode ?? 1);
}

if (skipTarballAndFormula) {
  process.exit(0);
}

const archiveInner = `spike-${version}`;
const stageRoot = path.join(root, 'artifacts', '.stage');
const stageInner = path.join(stageRoot, archiveInner);

rmSync(stageRoot, { force: true, recursive: true });
cpSync(distDir, path.join(stageInner, 'dist'), { recursive: true });
cpSync(path.join(root, 'src'), path.join(stageInner, 'src'), { recursive: true });
cpSync(path.join(root, 'package.json'), path.join(stageInner, 'package.json'));

mkdirSync(path.join(root, 'artifacts'), { recursive: true });
const tarName = `spike-${version}.tar.gz`;
const tarPath = path.join(root, 'artifacts', tarName);

const tar = Bun.spawnSync(['tar', '-czf', tarPath, '-C', stageRoot, archiveInner], {
  cwd: root,
  stderr: 'inherit',
  stdout: 'inherit',
});
if (tar.exitCode !== 0) {
  process.exit(tar.exitCode ?? 1);
}

rmSync(stageRoot, { force: true, recursive: true });

const sha256 = new Bun.CryptoHasher('sha256')
  .update(await Bun.file(tarPath).arrayBuffer())
  .digest('hex');

const formulaPath = path.join(root, 'Formula', 'spike.rb');
let rb = await Bun.file(formulaPath).text();
rb = rb.replace(/^(?<prefix>\s*version\s+")[^"]+(?<suffix>")/mu, `$<prefix>${version}$<suffix>`);
rb = rb.replace(
  /^(?<prefix>\s*sha256\s+")[0-9a-fA-F]+(?<suffix>")/mu,
  `$<prefix>${sha256}$<suffix>`,
);
await Bun.write(formulaPath, rb);

console.log(`Wrote ${tarPath}`);
console.log(`sha256 ${sha256}`);
console.log(`Updated Formula/spike.rb to version ${version}`);
