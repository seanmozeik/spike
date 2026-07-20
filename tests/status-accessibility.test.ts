import { Effect } from 'effect';
import { expect, it } from 'vitest';

import type { ProcessResult } from '../src/launchd';
import type { OperatorCommandPort } from '../src/operator/commands';
import { checkAccessibility } from '../src/status/accessibility-check';

const commandsWith = (result: ProcessResult): OperatorCommandPort => ({
  accessibilityStatus: (): Effect.Effect<ProcessResult> => Effect.succeed(result),
  launchctl: (): Effect.Effect<never> =>
    Effect.die(new Error('launchctl must not run in this test')),
  messagesAutomation: Effect.die(new Error('Messages automation must not run in this test')),
});

const result = (overrides: Partial<ProcessResult> = {}): ProcessResult => ({
  exitCode: 0,
  signalCode: null,
  stderr: '',
  stdout: '{"accessibilityTrusted":true,"locked":false}',
  timedOut: false,
  ...overrides,
});

it('turns malformed helper output into bounded warning diagnostics', async () => {
  const process = result({ stdout: 'not-json' });
  const diagnostics = await checkAccessibility('/tmp/spike-like', true, commandsWith(process));

  expect(diagnostics[0]?.detail).toContain('JSON');
  expect(diagnostics).toEqual([
    { detail: diagnostics[0]?.detail, name: 'Accessibility', state: 'warn' },
    { detail: 'unknown', name: 'lock state', state: 'warn' },
  ]);
});

it('distinguishes helper timeout from an ordinary nonzero diagnostic', async () => {
  const timedOutProcess = result({ exitCode: 1, signalCode: 'SIGKILL', timedOut: true });
  const timedOut = await checkAccessibility('/tmp/spike-like', true, commandsWith(timedOutProcess));

  expect(timedOut).toEqual([
    { detail: 'command timed out', name: 'Accessibility', state: 'warn' },
    { detail: 'unknown', name: 'lock state', state: 'warn' },
  ]);

  const deniedProcess = result({ exitCode: 1, stderr: 'permission denied' });
  const denied = await checkAccessibility('/tmp/spike-like', true, commandsWith(deniedProcess));

  expect(denied).toEqual([
    { detail: 'permission denied', name: 'Accessibility', state: 'warn' },
    { detail: 'unknown', name: 'lock state', state: 'warn' },
  ]);
});
