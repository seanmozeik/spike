import { Effect, Result } from 'effect';

import { isObject } from '../object-guard';
import type { OperatorCommandPort } from '../operator/commands';

interface AccessibilityDiagnostic {
  readonly detail: string;
  readonly name: 'Accessibility' | 'lock state';
  readonly state: 'pass' | 'warn';
}

const check = (
  name: AccessibilityDiagnostic['name'],
  state: AccessibilityDiagnostic['state'],
  detail: string,
): AccessibilityDiagnostic => ({ detail, name, state });

const checkAccessibility = async (
  helperPath: string,
  enabled: boolean,
  commands: OperatorCommandPort,
): Promise<readonly AccessibilityDiagnostic[]> => {
  if (!enabled) {
    return [check('Accessibility', 'pass', 'Likes disabled')];
  }
  try {
    const executed = await Effect.runPromise(
      Effect.result(commands.accessibilityStatus(helperPath)),
    );
    if (Result.isFailure(executed)) {
      return [
        check('Accessibility', 'warn', executed.failure.message),
        check('lock state', 'warn', 'unknown'),
      ];
    }
    const result = executed.success;
    if (result.timedOut) {
      return [
        check('Accessibility', 'warn', 'command timed out'),
        check('lock state', 'warn', 'unknown'),
      ];
    }
    if (result.exitCode !== 0) {
      return [
        check('Accessibility', 'warn', result.stderr.trim() || 'helper unavailable'),
        check('lock state', 'warn', 'unknown'),
      ];
    }
    const status: unknown = JSON.parse(result.stdout);
    if (!isObject(status)) {
      throw new Error('Accessibility helper returned a non-object response');
    }
    const trusted = status['accessibilityTrusted'] === true;
    const locked = status['locked'] === true;
    return [
      check('Accessibility', trusted ? 'pass' : 'warn', trusted ? 'trusted' : 'unavailable'),
      check('lock state', locked ? 'warn' : 'pass', locked ? 'locked' : 'unlocked'),
    ];
  } catch (error) {
    return [
      check('Accessibility', 'warn', error instanceof Error ? error.message : String(error)),
      check('lock state', 'warn', 'unknown'),
    ];
  }
};

export { checkAccessibility };
export type { AccessibilityDiagnostic };
