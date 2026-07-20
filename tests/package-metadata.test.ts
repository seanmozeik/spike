import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Schema } from 'effect';
import { expect, it } from 'vitest';

const PackageMetadata = Schema.Struct({
  bin: Schema.Record(Schema.String, Schema.String),
  cpu: Schema.Array(Schema.String),
  dependencies: Schema.Record(Schema.String, Schema.String),
  devDependencies: Schema.Record(Schema.String, Schema.String),
  files: Schema.Array(Schema.String),
  homepage: Schema.String,
  license: Schema.String,
  name: Schema.String,
  os: Schema.Array(Schema.String),
  repository: Schema.Struct({ url: Schema.String }),
  scripts: Schema.Record(Schema.String, Schema.String),
  version: Schema.String,
});
type PackageMetadata = typeof PackageMetadata.Type;

const decodeMetadata = Schema.decodeUnknownSync(PackageMetadata);
const decodeRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

const root = fileURLToPath(new URL('..', import.meta.url));

const packageMetadata = async (): Promise<{
  readonly metadata: PackageMetadata;
  readonly raw: Record<string, unknown>;
}> => {
  const text = await readFile(path.join(root, 'package.json'), 'utf8');
  const parsed = JSON.parse(text) as unknown;
  return { metadata: decodeMetadata(parsed), raw: decodeRecord(parsed) };
};

it('publishes one macOS arm64 CLI surface without raw TypeScript exports', async () => {
  const { metadata, raw } = await packageMetadata();

  expect(metadata.name).toBe('@seanmozeik/spike');
  expect(metadata.homepage).toBe('https://github.com/seanmozeik/spike#readme');
  expect(metadata.bin).toStrictEqual({ spike: './dist/spike' });
  expect(metadata.os).toStrictEqual(['darwin']);
  expect(metadata.cpu).toStrictEqual(['arm64']);
  expect(metadata.files).toStrictEqual(['dist', 'examples', 'LICENSE', 'README.md', 'SECURITY.md']);
  expect(raw['main']).toBeUndefined();
  expect(raw['types']).toBeUndefined();
  expect(raw['exports']).toBeUndefined();
  expect(metadata.dependencies['typescript']).toBeUndefined();
  expect(metadata.devDependencies['typescript']).toBeDefined();
  expect(metadata.scripts['typecheck']).toBe('bun scripts/typecheck.ts');
});

it('keeps package, formula, repository, version, and license identity aligned', async () => {
  const { metadata } = await packageMetadata();
  const formula = await readFile(path.join(root, 'Formula', 'spike.rb'), 'utf8');

  expect(metadata.license).toBe('MIT');
  expect(metadata.repository.url).toBe('git+https://github.com/seanmozeik/spike.git');
  expect(formula).toContain('homepage "https://github.com/seanmozeik/spike"');
  expect(formula).toContain(`version "${metadata.version}"`);
  expect(formula).toContain('license "MIT"');
  expect(formula).toContain('depends_on arch: :arm64');
  expect(formula).toContain('depends_on macos: :tahoe');
});
