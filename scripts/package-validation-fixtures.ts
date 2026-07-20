import { Database } from 'bun:sqlite';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface FixturePaths {
  readonly accountAuth: string;
  readonly accountsMarker: string;
  readonly codexConfig: string;
  readonly config: string;
  readonly database: string;
  readonly home: string;
  readonly prompt: string;
}

interface SpikeFixtureOptions {
  readonly codexExecutable: string;
  readonly customProvider: boolean;
  readonly messagesDatabase: string;
  readonly workingDirectory: string;
}

const fixturePaths = (home: string): FixturePaths => ({
  accountAuth: path.join(home, 'accounts', 'fixture', 'auth.json'),
  accountsMarker: path.join(home, 'accounts', 'fixture', 'account-note.json'),
  codexConfig: path.join(home, 'codex-home', 'config.toml'),
  config: path.join(home, 'config.toml'),
  database: path.join(home, 'state', 'spike.db'),
  home,
  prompt: path.join(home, 'prompt.md'),
});

const tomlString = (value: string): string => JSON.stringify(value);

const writeSpikeFixture = async (
  home: string,
  options: SpikeFixtureOptions,
): Promise<FixturePaths> => {
  const paths = fixturePaths(home);
  await Promise.all([
    mkdir(path.dirname(paths.accountsMarker), { mode: 0o700, recursive: true }),
    mkdir(path.dirname(paths.codexConfig), { mode: 0o700, recursive: true }),
    mkdir(path.dirname(paths.database), { mode: 0o700, recursive: true }),
  ]);
  const config = [
    'casing = "natural"',
    'chat_guid = "iMessage;-;spike@example.com"',
    `codex_executable = ${tomlString(options.codexExecutable)}`,
    `codex_home = ${tomlString(path.dirname(paths.codexConfig))}`,
    'emoji = "off"',
    'final_punctuation = "natural"',
    'handle = "spike@example.com"',
    'like_acknowledgements = false',
    `messages_database = ${tomlString(options.messagesDatabase)}`,
    `prompt_path = ${tomlString(paths.prompt)}`,
    'swearing = "off"',
    'wit = "dry"',
    `working_directory = ${tomlString(options.workingDirectory)}`,
    '',
  ].join('\n');
  const codexConfig = options.customProvider
    ? 'model_provider = "package-validation-fixture"\n'
    : 'model_provider = "openai"\n';
  await Promise.all([
    writeFile(paths.config, config, { mode: 0o600 }),
    writeFile(paths.codexConfig, codexConfig, { mode: 0o600 }),
    writeFile(paths.prompt, 'Keep the package validation fixture isolated.\n', { mode: 0o600 }),
    writeFile(paths.accountsMarker, '{"fixture":"preserve-me"}\n', { mode: 0o600 }),
  ]);
  return paths;
};

const createMessagesFixture = (databasePath: string): void => {
  const database = new Database(databasePath, { create: true, strict: true });
  try {
    for (const statement of [
      `CREATE TABLE chat (
        ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL, style INTEGER NOT NULL,
        chat_identifier TEXT NOT NULL, service_name TEXT NOT NULL
      )`,
      'CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT NOT NULL, service TEXT NOT NULL)',
      'CREATE TABLE chat_handle_join (chat_id INTEGER NOT NULL, handle_id INTEGER NOT NULL)',
      `CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL, text TEXT, attributedBody BLOB,
        date REAL NOT NULL, is_from_me INTEGER NOT NULL, cache_has_attachments INTEGER NOT NULL,
        service TEXT NOT NULL, handle_id INTEGER NOT NULL
      )`,
      'CREATE TABLE chat_message_join (chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL)',
      `CREATE TABLE attachment (
        ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL, filename TEXT, mime_type TEXT,
        transfer_name TEXT, uti TEXT, total_bytes INTEGER
      )`,
      'CREATE TABLE message_attachment_join (message_id INTEGER NOT NULL, attachment_id INTEGER NOT NULL)',
    ]) {
      database.run(statement);
    }
    database.run("INSERT INTO handle VALUES (1, 'spike@example.com', 'iMessage')");
    database.run(
      `INSERT INTO chat VALUES (
        1, 'iMessage;-;spike@example.com', 45, 'spike@example.com', 'iMessage'
      )`,
    );
    database.run('INSERT INTO chat_handle_join VALUES (1, 1)');
  } finally {
    database.close();
  }
};

const digestFile = async (file: string): Promise<string> =>
  new Bun.CryptoHasher('sha256').update(await readFile(file)).digest('hex');

const optionalDigest = async (file: string): Promise<null | string> =>
  (await Bun.file(file).exists()) ? digestFile(file) : null;

const preservedDigests = async (paths: FixturePaths): Promise<Record<string, null | string>> => ({
  account: await digestFile(paths.accountsMarker),
  accountAuth: await optionalDigest(paths.accountAuth),
  codex: await digestFile(paths.codexConfig),
  config: await digestFile(paths.config),
  prompt: await digestFile(paths.prompt),
});

const writeAccountFixture = (paths: FixturePaths): Promise<void> =>
  writeFile(paths.accountAuth, '{"fixture":"valid-auth"}\n', { mode: 0o600 });

const writeExecutable = async (file: string, source: string): Promise<void> => {
  await writeFile(file, source, { mode: 0o755 });
  await chmod(file, 0o755);
};

export {
  createMessagesFixture,
  fixturePaths,
  preservedDigests,
  writeAccountFixture,
  writeExecutable,
  writeSpikeFixture,
  type FixturePaths,
};
