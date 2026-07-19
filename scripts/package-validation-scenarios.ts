import assert from 'node:assert/strict';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Schema } from 'effect';

import {
  requireExit,
  requireFailureContaining,
  type CommandResult,
} from './package-validation-command';
import { isolatedEnvironment, runCli } from './package-validation-environment';
import {
  createMessagesFixture,
  preservedDigests,
  writeAccountFixture,
  writeSpikeFixture,
} from './package-validation-fixtures';
import {
  createCurrentJournal,
  createOldestJournal,
  currentSchemaVersion,
  journalSnapshot,
  journalVersion,
  preservedJournalRecords,
  seedCurrentApprovalRecord,
} from './package-validation-journal';
import { expectedVersionOneRecords } from './package-validation-journal-expected';
import {
  expectedCurrentMigrationContract,
  expectedVersionOneSchema,
  readCurrentMigrationContract,
  readJournalSchemaContract,
  seedCurrentScheduleRecords,
} from './package-validation-journal-schema';

const DiagnosticCheck = Schema.Struct({
  detail: Schema.String,
  name: Schema.String,
  state: Schema.Literals(['fail', 'pass', 'warn']),
});
const DoctorReport = Schema.Struct({
  checks: Schema.Array(DiagnosticCheck),
  healthy: Schema.Boolean,
  ok: Schema.Literal(true),
});
const decodeDoctor = Schema.decodeUnknownSync(DoctorReport);

interface DoctorExpectation {
  readonly detail: string;
  readonly name: string;
  readonly state: 'fail' | 'pass' | 'warn';
}

const doctorReport = (result: CommandResult, label: string): typeof DoctorReport.Type => {
  requireExit(result, 0, label);
  return decodeDoctor(JSON.parse(result.stdout) as unknown);
};

const assertDoctorCheck = (
  report: typeof DoctorReport.Type,
  expectation: DoctorExpectation,
): void => {
  const check = report.checks.find(({ name }) => name === expectation.name);
  if (check === undefined) {
    throw new Error(`doctor check missing: ${expectation.name}`);
  }
  assert.equal(check.state, expectation.state, JSON.stringify(report));
  assert.equal(
    check.detail.includes(expectation.detail),
    true,
    `doctor ${expectation.name} detail did not include ${expectation.detail}: ${check.detail}`,
  );
};

const writeLaunchAgentFixture = async (userHome: string, spikeHome: string): Promise<void> => {
  const launchAgent = path.join(userHome, 'Library', 'LaunchAgents', 'com.mozeik.spike.plist');
  await mkdir(path.dirname(launchAgent), { recursive: true });
  await writeFile(
    launchAgent,
    `com.mozeik.spike\n${spikeHome}\n${path.join(spikeHome, 'codex-home')}\nCODEX_EXECUTABLE\n<key>PATH</key>\n`,
  );
};

const validateDiagnostics = async (
  validationRoot: string,
  cli: string,
  work: string,
  fakeBin: string,
): Promise<void> => {
  const userHome = path.join(validationRoot, 'users', 'doctor');
  await mkdir(userHome, { recursive: true });
  const missingHome = path.join(validationRoot, 'homes', 'missing');
  const missing = await runCli(
    cli,
    ['doctor', '--json'],
    work,
    isolatedEnvironment(validationRoot, missingHome, userHome, fakeBin),
    'doctor missing configuration',
  );
  const missingReport = doctorReport(missing, 'doctor missing configuration');
  assertDoctorCheck(missingReport, {
    detail: `failed to read ${path.join(missingHome, 'config.toml')}`,
    name: 'config',
    state: 'fail',
  });
  await assert.rejects(lstat(missingHome));

  const malformedHome = path.join(validationRoot, 'homes', 'malformed');
  await mkdir(malformedHome, { recursive: true });
  await writeFile(path.join(malformedHome, 'config.toml'), '[invalid');
  const malformed = await runCli(
    cli,
    ['doctor', '--json'],
    work,
    isolatedEnvironment(validationRoot, malformedHome, userHome, fakeBin),
    'doctor malformed configuration',
  );
  const malformedReport = doctorReport(malformed, 'doctor malformed configuration');
  assertDoctorCheck(malformedReport, {
    detail: `invalid ${path.join(malformedHome, 'config.toml')}`,
    name: 'config',
    state: 'fail',
  });

  const validHome = path.join(validationRoot, 'homes', 'valid');
  const messagesDatabase = path.join(validationRoot, 'messages-valid.db');
  createMessagesFixture(messagesDatabase);
  const validPaths = await writeSpikeFixture(validHome, {
    codexExecutable: path.join(validationRoot, 'bin', 'fake-codex'),
    customProvider: true,
    messagesDatabase,
    workingDirectory: work,
  });
  createCurrentJournal(validPaths.database);
  await writeLaunchAgentFixture(userHome, validHome);
  const valid = await runCli(
    cli,
    ['doctor', '--json'],
    work,
    isolatedEnvironment(validationRoot, validHome, userHome, fakeBin),
    'doctor valid fixture configuration',
  );
  const validReport = doctorReport(valid, 'doctor valid fixture configuration');
  for (const expectation of [
    { detail: 'spike@example.com / iMessage;-;spike@example.com', name: 'config', state: 'pass' },
    { detail: `schema ${String(currentSchemaVersion)} wal`, name: 'journal', state: 'pass' },
    { detail: messagesDatabase, name: 'chat.db FDA', state: 'pass' },
    {
      detail: 'spike@example.com / iMessage;-;spike@example.com',
      name: 'configured conversation',
      state: 'pass',
    },
  ] as const) {
    assertDoctorCheck(validReport, expectation);
  }
};

const upgradeFailure = (result: CommandResult, label: string): void => {
  requireFailureContaining(
    result,
    {
      allOf: ['failed to open Codex account fixture', 'failed to spawn Codex app-server'],
      platformOneOf: ['ENOENT', 'posix_spawn failed'],
    },
    label,
  );
};

const validateUpgrade = async (
  validationRoot: string,
  cli: string,
  work: string,
  fakeBin: string,
): Promise<void> => {
  const home = path.join(validationRoot, 'homes', 'upgrade');
  const userHome = path.join(validationRoot, 'users', 'upgrade');
  await mkdir(userHome, { recursive: true });
  const messagesDatabase = path.join(validationRoot, 'messages-upgrade.db');
  createMessagesFixture(messagesDatabase);
  const paths = await writeSpikeFixture(home, {
    codexExecutable: path.join(validationRoot, 'bin', 'missing-codex'),
    customProvider: false,
    messagesDatabase,
    workingDirectory: work,
  });
  await writeAccountFixture(paths);
  createOldestJournal(paths.database);
  const beforeFiles = await preservedDigests(paths);
  const beforeJournalRecords = preservedJournalRecords(paths.database);
  assert.deepEqual(beforeJournalRecords, expectedVersionOneRecords);
  assert.deepEqual(readJournalSchemaContract(paths.database), expectedVersionOneSchema);
  const environment = isolatedEnvironment(validationRoot, home, userHome, fakeBin);
  upgradeFailure(
    await runCli(cli, ['serve'], work, environment, 'upgrade oldest schema'),
    'upgrade oldest schema',
  );
  assert.equal(journalVersion(paths.database), currentSchemaVersion);
  assert.deepEqual(preservedJournalRecords(paths.database), beforeJournalRecords);
  assert.deepEqual(readCurrentMigrationContract(paths.database), expectedCurrentMigrationContract);
  assert.deepEqual(await preservedDigests(paths), beforeFiles);

  seedCurrentApprovalRecord(paths.database);
  seedCurrentScheduleRecords(paths.database);
  const currentRecords = preservedJournalRecords(paths.database);
  assert.equal(currentRecords.approvals.length, 1);
  const firstJournal = journalSnapshot(paths.database);

  upgradeFailure(
    await runCli(cli, ['serve'], work, environment, 'rerun upgraded schema'),
    'rerun upgraded schema',
  );
  assert.equal(journalSnapshot(paths.database), firstJournal);
  assert.deepEqual(preservedJournalRecords(paths.database), currentRecords);
  assert.deepEqual(readCurrentMigrationContract(paths.database), expectedCurrentMigrationContract);
  assert.deepEqual(await preservedDigests(paths), beforeFiles);
};

export { validateDiagnostics, validateUpgrade };
