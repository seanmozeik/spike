import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { parseModelCatalog, renderCodexConfig } from '../src/onboarding/codex';
import { discoverDirectConversations, normalizePeerHandle } from '../src/onboarding/conversation';
import { bunVersionSupported } from '../src/onboarding/preflight';
import { observeRoundTrip } from '../src/onboarding/round-trip';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const messagesFixture = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-onboarding-chat-'));
  roots.push(root);
  const databasePath = path.join(root, 'chat.db');
  const database = new Database(databasePath, { create: true, strict: true });
  database.run('CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT NOT NULL)');
  database.run('CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, style INTEGER)');
  database.run('CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER)');
  database.run('CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER)');
  database.run('CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER)');
  database.run("INSERT INTO handle VALUES (1, 'Spike@iCloud.com'), (2, '+15555550199')");
  database.run(
    "INSERT INTO chat VALUES (1, 'direct-email', 45), (2, 'group', 45), (3, 'direct-phone', 45)",
  );
  database.run('INSERT INTO chat_handle_join VALUES (1, 1), (2, 1), (2, 2), (3, 2)');
  database.run('INSERT INTO message VALUES (1, 1000000)');
  database.run('INSERT INTO chat_message_join VALUES (1, 1)');
  database.close();
  return databasePath;
};

const roundTripFixture = (): { readonly database: Database; readonly path: string } => {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-round-trip-'));
  roots.push(root);
  const databasePath = path.join(root, 'chat.db');
  const database = new Database(databasePath, { create: true, strict: true });
  database.run('CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT NOT NULL)');
  database.run('CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT)');
  database.run('CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER)');
  database.run(
    'CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER, is_from_me INTEGER, service TEXT, handle_id INTEGER)',
  );
  database.run("INSERT INTO handle VALUES (1, 'spike@icloud.com')");
  database.run("INSERT INTO chat VALUES (1, 'direct-email')");
  const appleDate = (Date.UTC(2026, 6, 17, 10) - 978_307_200_000) * 1_000_000;
  database.run("INSERT INTO message VALUES (1, ?, 0, 'iMessage', 1)", [appleDate]);
  database.run("INSERT INTO message VALUES (2, ?, 1, 'SMS', 1)", [appleDate]);
  database.run('INSERT INTO chat_message_join VALUES (1, 1), (1, 2)');
  return { database, path: databasePath };
};

it('normalizes E.164 and iCloud handles while rejecting ambiguous phone input', () => {
  expect(normalizePeerHandle(' +44 7700 900123 ')).toBe('+447700900123');
  expect(normalizePeerHandle('Spike@iCloud.com')).toBe('spike@icloud.com');
  expect(() => normalizePeerHandle('07700 900123')).toThrow('E.164');
});

it('discovers only exact style-45 conversations with one participant', () => {
  const database = messagesFixture();
  expect(discoverDirectConversations(database, 'spike@icloud.com')).toMatchObject([
    { chatGuid: 'direct-email', handle: 'spike@icloud.com' },
  ]);
  expect(discoverDirectConversations(database, '+15555550199')).toMatchObject([
    { chatGuid: 'direct-phone', handle: '+15555550199' },
  ]);
});

it('maps the live Codex catalog fields used by the questionnaire', () => {
  const models = parseModelCatalog({
    models: [
      {
        additional_speed_tiers: ['fast'],
        default_reasoning_level: 'high',
        description: 'Frontier',
        display_name: 'GPT Test',
        slug: 'gpt-test',
        supported_reasoning_levels: [{ description: 'Deep', effort: 'high' }],
        visibility: 'list',
      },
    ],
  });
  expect(models).toMatchObject([
    {
      defaultReasoning: 'high',
      displayName: 'GPT Test',
      reasoning: [{ effort: 'high' }],
      serviceTiers: [{ id: 'fast' }],
      slug: 'gpt-test',
    },
  ]);
});

it('overrides policy in a custom Codex config without duplicate TOML keys', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-custom-codex-'));
  roots.push(root);
  const config = path.join(root, 'config.toml');
  writeFileSync(
    config,
    'model = "local"\napproval_policy = "on-request"\n[model_providers.local]\nname = "Local"\n',
  );
  const rendered = await renderCodexConfig(
    { configPath: config, kind: 'custom' },
    'never',
    'read-only',
  );
  expect(Bun.TOML.parse(rendered)).toMatchObject({
    approval_policy: 'never',
    model: 'local',
    model_providers: { local: { name: 'Local' } },
    sandbox_mode: 'read-only',
  });
  expect(rendered.match(/approval_policy/gu)).toHaveLength(1);
  expect(rendered).not.toContain('[analytics]');
});

it('renders policy and privacy defaults for generated Codex configs', async () => {
  const rendered = await renderCodexConfig({ kind: 'skip' }, 'on-request', 'workspace-write');
  expect(Bun.TOML.parse(rendered)).toMatchObject({
    analytics: { enabled: false },
    approval_policy: 'on-request',
    feedback: { enabled: false },
    history: { persistence: 'none' },
    otel: {
      exporter: 'none',
      log_user_prompt: false,
      metrics_exporter: 'none',
      trace_exporter: 'none',
    },
    sandbox_mode: 'workspace-write',
  });
  expect(rendered).not.toContain('responses_websockets');
});

it('keeps privacy defaults alongside generated OpenAI model settings', async () => {
  const rendered = await renderCodexConfig(
    {
      kind: 'openai',
      model: 'gpt-test',
      personality: 'pragmatic',
      reasoning: 'high',
      serviceTier: 'fast',
    },
    'never',
    'danger-full-access',
  );
  expect(Bun.TOML.parse(rendered)).toMatchObject({
    analytics: { enabled: false },
    feedback: { enabled: false },
    history: { persistence: 'none' },
    model: 'gpt-test',
    otel: { exporter: 'none', log_user_prompt: false },
    service_tier: 'fast',
  });
});

it('enforces the Bun 1.3 engine floor', () => {
  expect(bunVersionSupported('1.2.99')).toBe(false);
  expect(bunVersionSupported('1.3.0')).toBe(true);
  expect(bunVersionSupported('2.0.0')).toBe(true);
});

it('accepts a first reply only when both legs are iMessage in the configured chat', () => {
  const fixture = roundTripFixture();
  const candidate = { chatGuid: 'direct-email', handle: 'spike@icloud.com', lastMessageAt: null };
  expect(observeRoundTrip(fixture.path, candidate, new Date('2026-07-17T09:59:00Z'))).toBe(false);
  fixture.database.run("UPDATE message SET service = 'iMessage' WHERE ROWID = 2");
  fixture.database.close();
  expect(observeRoundTrip(fixture.path, candidate, new Date('2026-07-17T09:59:00Z'))).toBe(true);
});
