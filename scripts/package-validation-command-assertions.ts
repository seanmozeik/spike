interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface FailureOutputContract {
  readonly allOf: readonly string[];
  readonly platformOneOf: readonly string[];
}

const requireExit = (result: CommandResult, expected: number, label: string): void => {
  if (result.exitCode !== expected) {
    throw new Error(
      `${label} exited ${String(result.exitCode)}, expected ${String(expected)}\n${result.stdout}${result.stderr}`,
    );
  }
};

const requireFailureOutput = (result: CommandResult, label: string): string => {
  if (result.exitCode === 0) {
    throw new Error(`${label} unexpectedly succeeded`);
  }
  return `${result.stdout}\n${result.stderr}`;
};

const requireFailureContaining = (
  result: CommandResult,
  contract: FailureOutputContract,
  label: string,
): void => {
  const output = requireFailureOutput(result, label);
  const missing = contract.allOf.filter((fragment) => !output.includes(fragment));
  if (missing.length > 0) {
    throw new Error(`${label} was not actionable; missing ${missing.join(', ')}\n${output}`);
  }
  if (
    contract.platformOneOf.length > 0 &&
    !contract.platformOneOf.some((fragment) => output.includes(fragment))
  ) {
    throw new Error(
      `${label} was not actionable; expected one platform cause from ${contract.platformOneOf.join(', ')}\n${output}`,
    );
  }
};

const requireFailureExactly = (result: CommandResult, expected: string, label: string): void => {
  requireFailureOutput(result, label);
  if (result.stdout !== '' || result.stderr !== `${expected}\n`) {
    throw new Error(
      `${label} error output changed\nexpected stderr: ${JSON.stringify(expected)}\nactual stdout: ${JSON.stringify(result.stdout)}\nactual stderr: ${JSON.stringify(result.stderr)}`,
    );
  }
};

export { requireExit, requireFailureContaining, requireFailureExactly, type CommandResult };
