import { plainLogText } from './plain-text';

interface FailureDiagnostic {
  readonly at: Date;
  readonly errorTag: string;
  readonly message: string;
  readonly operation: string;
}

interface FailureLog {
  readonly report: (diagnostic: FailureDiagnostic) => void;
}

interface FailureLogOptions {
  readonly repeatIntervalMs?: number;
  readonly write?: (line: string) => void;
}

interface FailureGroup {
  readonly emittedAt: number;
  readonly suppressed: number;
}

const DEFAULT_REPEAT_INTERVAL_MS = 60_000;
const MAX_FAILURE_GROUPS = 32;

const diagnosticKey = (diagnostic: FailureDiagnostic): string =>
  `${diagnostic.operation}\u{0}${diagnostic.errorTag}\u{0}${diagnostic.message}`;

const formatDiagnostic = (diagnostic: FailureDiagnostic, suppressed: number): string => {
  const repeatDetail = suppressed === 0 ? '' : ` suppressed_repeats=${String(suppressed)}`;
  return `${diagnostic.at.toISOString()} [error] ${diagnostic.operation} ${diagnostic.errorTag}: ${diagnostic.message}${repeatDetail}`;
};

const forgetOldest = (groups: Map<string, FailureGroup>): void => {
  const oldest = groups.keys().next().value;
  if (oldest !== undefined) {
    groups.delete(oldest);
  }
};

const makeFailureLog = (options: FailureLogOptions = {}): FailureLog => {
  const groups = new Map<string, FailureGroup>();
  const repeatIntervalMs = options.repeatIntervalMs ?? DEFAULT_REPEAT_INTERVAL_MS;
  const write =
    options.write ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });
  const emit = (line: string): void => {
    try {
      write(line);
    } catch {
      // Failure reporting must never replace the primary application failure.
    }
  };
  return {
    report: (diagnostic) => {
      const normalized = { ...diagnostic, message: plainLogText(diagnostic.message) };
      const key = diagnosticKey(normalized);
      const previous = groups.get(key);
      const emittedAt = normalized.at.getTime();
      if (previous !== undefined && emittedAt - previous.emittedAt < repeatIntervalMs) {
        groups.set(key, { ...previous, suppressed: previous.suppressed + 1 });
        return;
      }
      const suppressed = previous?.suppressed ?? 0;
      if (previous === undefined && groups.size >= MAX_FAILURE_GROUPS) {
        forgetOldest(groups);
      } else {
        groups.delete(key);
      }
      groups.set(key, { emittedAt, suppressed: 0 });
      emit(formatDiagnostic(normalized, suppressed));
    },
  };
};

export { makeFailureLog };
export type { FailureDiagnostic, FailureLog, FailureLogOptions };
