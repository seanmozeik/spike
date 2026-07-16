import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import { afterEach, expect } from 'vitest';

import { loadSpikeConfig } from '../src/app-config';
import { ensureRuntimeLayout } from '../src/config-files';
import { spikePaths } from '../src/paths';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it.effect('loads typed overrides and expands home-relative paths', () =>
  Effect.gen(function* typedConfig() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-app-config-'));
    roots.push(root);
    const paths = spikePaths(root);
    yield* ensureRuntimeLayout(paths);
    writeFileSync(
      paths.config,
      `chat_guid = "any;-;+15555550199"
handle = "+15555550199"
working_directory = "/tmp/example-workspace"
prompt_path = "${root}/custom-prompt.md"
codex_home = "${root}/custom-codex"
codex_executable = "/usr/local/bin/codex"
casing = "natural"
emoji = "off"
final_punctuation = "natural"
swearing = "filthy"
wit = "playful"
seed_auth_path = "${root}/auth.json"
messages_database = "${root}/chat.db"
like_acknowledgements = false
`,
    );
    const config = yield* loadSpikeConfig(paths);
    expect(config).toMatchObject({
      casing: 'natural',
      codexExecutable: '/usr/local/bin/codex',
      codexHome: `${root}/custom-codex`,
      emoji: 'off',
      finalPunctuation: 'natural',
      handle: '+15555550199',
      likeAcknowledgements: false,
      messagesDatabase: `${root}/chat.db`,
      promptPath: `${root}/custom-prompt.md`,
      seedAuthPath: `${root}/auth.json`,
      swearing: 'filthy',
      wit: 'playful',
      workingDirectory: '/tmp/example-workspace',
    });
  }),
);

it.effect('loads personality defaults and rejects unknown modes', () =>
  Effect.gen(function* emojiConfig() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-emoji-config-'));
    roots.push(root);
    const paths = spikePaths(root);
    yield* ensureRuntimeLayout(paths);
    expect(yield* loadSpikeConfig(paths)).toMatchObject({
      casing: 'lowercase',
      emoji: 'after_user',
      finalPunctuation: 'no_full_stop',
      swearing: 'tasteful',
      wit: 'dry',
    });
    writeFileSync(
      paths.config,
      `chat_guid = "any;-;+15555550199"
handle = "+15555550199"
working_directory = "/tmp/example-workspace"
emoji = "sometimes"
`,
    );
    const result = yield* Effect.result(loadSpikeConfig(paths));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain('emoji');
    }
  }),
);

it.effect('rejects the removed repo alias', () =>
  Effect.gen(function* removedAlias() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-removed-alias-'));
    roots.push(root);
    const paths = spikePaths(root);
    yield* ensureRuntimeLayout(paths);
    writeFileSync(
      paths.config,
      `chat_guid = "any;-;+15555550199"
handle = "+15555550199"
repo = "/tmp/legacy-workspace"
`,
    );
    const result = yield* Effect.result(loadSpikeConfig(paths));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain('working_directory');
    }
  }),
);

it.effect('reports the malformed field at the configuration boundary', () =>
  Effect.gen(function* malformedConfig() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-invalid-config-'));
    roots.push(root);
    const paths = spikePaths(root);
    yield* ensureRuntimeLayout(paths);
    writeFileSync(paths.config, 'chat_guid = 42\nhandle = "+15555550199"\n');
    const result = yield* Effect.result(loadSpikeConfig(paths));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain('chat_guid');
    }
  }),
);
