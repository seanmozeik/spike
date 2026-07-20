#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pkg from '../package.json' with { type: 'json' };
import { assertExtractedArchiveRoot, validateArchiveMembers } from './package-validation-archive';
import { recordedCommands, requireExit, runCommand } from './package-validation-command';
import {
  COMMAND_TIMEOUT_MS,
  isolatedEnvironment,
  makeFakeCodex,
  makeOperatorFixtures,
  runCli,
  runPreview,
} from './package-validation-environment';
import { validateActionableFailures } from './package-validation-failures';
import { inspectInstalledTree } from './package-validation-inspection';
import { currentSchemaVersion } from './package-validation-journal';
import { detachReleaseArchive } from './package-validation-release';
import { validateDiagnostics, validateUpgrade } from './package-validation-scenarios';
import { changedTreePaths, snapshotTree } from './package-validation-tree';

const root = fileURLToPath(new URL('..', import.meta.url));
const BUILD_TIMEOUT_MS = 120_000;
const BANNER_MARKER = '____________ |__|';
const sourceCopyExclusions = new Set(['.ast-bro', '.git', 'artifacts', 'dist', 'node_modules']);
const sourceSnapshotExclusions = new Set(['.ast-bro', '.git', 'node_modules']);

const releaseBuildEnvironment = (validationRoot: string): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  BUN_INSTALL_CACHE_DIR: path.join(validationRoot, 'cache', 'build-bun'),
  CLANG_MODULE_CACHE_PATH: path.join(validationRoot, 'cache', 'clang'),
  HOME: path.join(validationRoot, 'users', 'build'),
  SWIFT_MODULE_CACHE_PATH: path.join(validationRoot, 'cache', 'swift'),
  TEMP: path.join(validationRoot, 'tmp'),
  TMP: path.join(validationRoot, 'tmp'),
  TMPDIR: path.join(validationRoot, 'tmp'),
  XDG_CACHE_HOME: path.join(validationRoot, 'cache', 'build-xdg'),
});

const stageSourceCopy = async (validationRoot: string): Promise<string> => {
  const sourceRoot = path.join(validationRoot, 'source');
  await cp(root, sourceRoot, {
    filter: (source) => {
      const [topLevel] = path.relative(root, source).split(path.sep);
      return topLevel === '' || topLevel === undefined || !sourceCopyExclusions.has(topLevel);
    },
    recursive: true,
  });
  await cp(path.join(root, 'node_modules'), path.join(sourceRoot, 'node_modules'), {
    recursive: true,
  });
  return sourceRoot;
};

const buildRelease = async (
  sourceRoot: string,
  validationRoot: string,
): Promise<{ readonly archive: string; readonly hash: string }> => {
  const build = await runCommand({
    argv: ['bun', 'run', 'build'],
    cwd: sourceRoot,
    environment: releaseBuildEnvironment(validationRoot),
    label: 'build release artifact',
    recordedCwd: '<temporary source copy>',
    timeoutMs: BUILD_TIMEOUT_MS,
  });
  requireExit(build, 0, 'build release artifact');
  const archive = path.join(sourceRoot, 'artifacts', `spike-${pkg.version}.tar.gz`);
  const hash = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  return { archive, hash };
};

const unpackRelease = async (
  archive: string,
  validationRoot: string,
): Promise<{ readonly cli: string; readonly installedRoot: string }> => {
  const prefix = path.join(validationRoot, 'prefix');
  const expectedRoot = `spike-${pkg.version}`;
  await mkdir(prefix, { mode: 0o700, recursive: true });
  const listing = await runCommand({
    argv: ['/usr/bin/tar', '-tzf', archive],
    cwd: validationRoot,
    environment: {},
    label: 'inspect release archive',
    recordedArgv: ['/usr/bin/tar', '-tzf', '<detached release archive>'],
    recordedCwd: '<temporary root>',
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  requireExit(listing, 0, 'inspect release archive');
  validateArchiveMembers(listing.stdout, expectedRoot);
  const unpack = await runCommand({
    argv: ['/usr/bin/tar', '-xzf', archive, '-C', prefix],
    cwd: validationRoot,
    environment: {},
    label: 'unpack release artifact',
    recordedArgv: [
      '/usr/bin/tar',
      '-xzf',
      '<detached release archive>',
      '-C',
      '<temporary prefix>',
    ],
    recordedCwd: '<temporary root>',
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  requireExit(unpack, 0, 'unpack release artifact');
  await assertExtractedArchiveRoot(prefix, expectedRoot);
  const installedRoot = path.join(prefix, expectedRoot);
  return { cli: path.join(installedRoot, 'dist', 'spike'), installedRoot };
};

const validateCliSurface = async (
  validationRoot: string,
  cli: string,
  work: string,
  fakeBin: string,
): Promise<void> => {
  const environment = isolatedEnvironment(
    validationRoot,
    path.join(validationRoot, 'homes', 'smoke'),
    path.join(validationRoot, 'users', 'smoke'),
    fakeBin,
  );
  const help = await runCli(cli, ['--help'], work, environment, 'packaged --help');
  requireExit(help, 0, '--help');
  assert.match(help.stdout, new RegExp(BANNER_MARKER, 'u'));
  const version = await runCli(cli, ['--version'], work, environment, 'packaged --version');
  requireExit(version, 0, '--version');
  assert.match(version.stdout, new RegExp(BANNER_MARKER, 'u'));
  assert.match(version.stdout, new RegExp(pkg.version.replaceAll('.', String.raw`\.`), 'u'));
  await runPreview(validationRoot, cli, work, fakeBin);
};

const validateInstalledRelease = async (
  archive: string,
  validationRoot: string,
  privateSourceRoots: readonly string[],
): Promise<void> => {
  const work = path.join(validationRoot, 'work');
  const fakeBin = path.join(validationRoot, 'bin');
  await Promise.all([
    mkdir(work, { mode: 0o700, recursive: true }),
    mkdir(path.join(validationRoot, 'tmp'), { mode: 0o700, recursive: true }),
  ]);
  await makeOperatorFixtures(fakeBin);
  const fakeCodex = path.join(fakeBin, 'fake-codex');
  await makeFakeCodex(fakeCodex);
  const { cli, installedRoot } = await unpackRelease(archive, validationRoot);
  await inspectInstalledTree(installedRoot, privateSourceRoots);
  await validateCliSurface(validationRoot, cli, work, fakeBin);
  await validateDiagnostics(validationRoot, cli, work, fakeBin);
  await validateUpgrade(validationRoot, cli, work, fakeBin);
  await validateActionableFailures(validationRoot, cli, work, fakeBin, fakeCodex);
};

const validatePackage = async (): Promise<{ readonly archiveHash: string }> => {
  const sourceBefore = await snapshotTree(root, { ignoredTopLevel: sourceSnapshotExclusions });
  const validationRoot = await mkdtemp(path.join(tmpdir(), 'spike-package-validation-'));
  try {
    await Promise.all([
      mkdir(path.join(validationRoot, 'cache'), { recursive: true }),
      mkdir(path.join(validationRoot, 'tmp'), { recursive: true }),
      mkdir(path.join(validationRoot, 'users', 'build'), { recursive: true }),
    ]);
    const sourceRoot = await stageSourceCopy(validationRoot);
    const privateSourceRoots = [
      ...new Set([root, await realpath(root), sourceRoot, await realpath(sourceRoot)]),
    ];
    const release = await buildRelease(sourceRoot, validationRoot);
    const detachedArchive = await detachReleaseArchive(validationRoot, sourceRoot, release.archive);
    await validateInstalledRelease(detachedArchive, validationRoot, privateSourceRoots);
    return { archiveHash: release.hash };
  } finally {
    const expectedPrefix = path.join(tmpdir(), 'spike-package-validation-');
    assert.equal(validationRoot.startsWith(expectedPrefix), true);
    await rm(validationRoot, { force: true, recursive: true });
    const changedSourcePaths = changedTreePaths(
      sourceBefore,
      await snapshotTree(root, { ignoredTopLevel: sourceSnapshotExclusions }),
    );
    assert.deepEqual(
      changedSourcePaths,
      [],
      `package validation changed source checkout entries: ${changedSourcePaths.join(', ')}`,
    );
  }
};

const result = await validatePackage();
console.log(
  JSON.stringify(
    {
      archive: `artifacts/spike-${pkg.version}.tar.gz`,
      archiveHash: result.archiveHash,
      commands: recordedCommands(),
      schemaVersion: currentSchemaVersion,
    },
    null,
    2,
  ),
);
