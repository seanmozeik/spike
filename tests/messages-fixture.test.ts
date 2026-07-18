import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import { makeMessagesFixture } from './messages-fixture';

it('closes the database and removes its temp root when schema setup fails', () => {
  let failedDatabase: Database | undefined;
  let fixtureRoot: string | undefined;
  expect(() =>
    makeMessagesFixture((database) => {
      failedDatabase = database;
      fixtureRoot = path.dirname(database.filename);
      database.run('CREATE TABLE partial_schema (id INTEGER PRIMARY KEY)');
      throw new Error('scripted schema failure');
    }),
  ).toThrow('scripted schema failure');
  const closedDatabase = failedDatabase;
  const removedRoot = fixtureRoot;
  if (closedDatabase === undefined || removedRoot === undefined) {
    throw new Error('Messages fixture did not reach schema setup');
  }
  expect(() => closedDatabase.run('SELECT 1')).toThrow('Database has closed');
  expect(existsSync(removedRoot)).toBe(false);
});

it('removes its exact temp root when database close fails', () => {
  const fixture = makeMessagesFixture();
  const closeDatabase = fixture.database.close.bind(fixture.database);
  Object.defineProperty(fixture.database, 'close', {
    value: (): void => {
      closeDatabase();
      throw new Error('scripted close failure');
    },
  });
  expect(fixture.close).toThrow('scripted close failure');
  expect(existsSync(fixture.root)).toBe(false);
});
