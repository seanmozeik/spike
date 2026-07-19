import { appendFile } from 'node:fs/promises';

type CodexLogMode = 'quiet' | 'verbose';

type RepetitiveCodexFlow = 'model-refresh-timeout' | 'responses-websocket-unavailable';

interface CodexStderrPolicy {
  readonly accept: (line: string) => readonly string[];
  readonly flush: () => readonly string[];
}

interface CodexStderrLog {
  readonly close: () => Promise<void>;
  readonly write: (line: string) => void;
}

interface ParsedRustLogLine {
  readonly level: 'DEBUG' | 'ERROR' | 'INFO' | 'TRACE' | 'WARN';
  readonly message: string;
  readonly module: string;
}

interface RepetitionGroup {
  count: number;
  readonly flow: RepetitiveCodexFlow;
}

const SUMMARY_INTERVAL = 25;
const ANSI_CSI = '\u{1B}[';
const RUST_LOG_LINE =
  /^\S+\s+(?<level>TRACE|DEBUG|INFO|WARN|ERROR)\s+(?<module>\S+):\s+(?<message>.*)$/u;
const STATE_TRANSITION =
  /\b(?:exited|initialized|restarted|shutting down|started|starting|stopped|stopping)\b/iu;

const stripAnsi = (line: string): string => {
  const output: string[] = [];
  let remaining = line;
  let start = remaining.indexOf(ANSI_CSI);
  while (start !== -1) {
    const end = remaining.indexOf('m', start + ANSI_CSI.length);
    if (end === -1) {
      break;
    }
    output.push(remaining.slice(0, start));
    remaining = remaining.slice(end + 1);
    start = remaining.indexOf(ANSI_CSI);
  }
  output.push(remaining);
  return output.join('');
};

const isLogLevel = (value: string | undefined): value is ParsedRustLogLine['level'] =>
  value === 'TRACE' ||
  value === 'DEBUG' ||
  value === 'INFO' ||
  value === 'WARN' ||
  value === 'ERROR';

const parseRustLogLine = (line: string): ParsedRustLogLine | null => {
  const groups = RUST_LOG_LINE.exec(stripAnsi(line))?.groups;
  const level = groups?.['level'];
  const module = groups?.['module'];
  const message = groups?.['message'];
  if (!isLogLevel(level) || module === undefined || message === undefined) {
    return null;
  }
  return { level, message, module };
};

const repetitiveFlow = (line: ParsedRustLogLine): RepetitiveCodexFlow | null => {
  if (
    line.module === 'codex_api::endpoint::responses_websocket' &&
    line.message.startsWith('failed to connect to websocket:')
  ) {
    return 'responses-websocket-unavailable';
  }
  if (
    line.module === 'codex_models_manager::manager' &&
    line.message.startsWith(
      'failed to refresh available models: timeout waiting for child process to exit',
    )
  ) {
    return 'model-refresh-timeout';
  }
  return null;
};

const repeatSummary = (flow: RepetitiveCodexFlow, count: number): string =>
  `[warn] codex app-server repeats suppressed flow=${flow} count=${String(count)}`;

const repetitionKey = (flow: RepetitiveCodexFlow, message: string): string => `${flow}:${message}`;

const flushSummaries = (groups: Map<string, RepetitionGroup>): readonly string[] => {
  const summaries: string[] = [];
  for (const group of groups.values()) {
    if (group.count > 0) {
      summaries.push(repeatSummary(group.flow, group.count));
      group.count = 0;
    }
  }
  return summaries;
};

const makeCodexStderrPolicy = (mode: CodexLogMode): CodexStderrPolicy => {
  if (mode === 'verbose') {
    return { accept: (line) => [line], flush: () => [] };
  }

  const repetitions = new Map<string, RepetitionGroup>();
  const recordRepetition = (
    flow: RepetitiveCodexFlow,
    message: string,
  ): readonly string[] | null => {
    const key = repetitionKey(flow, message);
    const group = repetitions.get(key);
    if (group === undefined) {
      repetitions.set(key, { count: 0, flow });
      return null;
    }
    group.count += 1;
    if (group.count < SUMMARY_INTERVAL) {
      return [];
    }
    const summary = repeatSummary(flow, group.count);
    group.count = 0;
    return [summary];
  };

  return {
    accept: (line) => {
      const parsed = parseRustLogLine(line);
      if (parsed === null) {
        return [line];
      }
      if (parsed.level === 'TRACE' || parsed.level === 'DEBUG') {
        return [];
      }
      const flow = repetitiveFlow(parsed);
      if (flow !== null) {
        return recordRepetition(flow, parsed.message) ?? [line];
      }
      if (parsed.level === 'INFO' && !STATE_TRANSITION.test(parsed.message)) {
        return [];
      }
      return [line];
    },
    flush: () => flushSummaries(repetitions),
  };
};

const appendDiagnostic = async (path: string, line: string): Promise<void> => {
  try {
    await appendFile(path, `${line}\n`, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[error] Spike could not persist Codex stderr: ${detail}\n${line}\n`);
  }
};

const appendAfter = async (previous: Promise<void>, path: string, line: string): Promise<void> => {
  await previous;
  await appendDiagnostic(path, line);
};

const makeCodexStderrLog = (path: string, mode: CodexLogMode): CodexStderrLog => {
  const policy = makeCodexStderrPolicy(mode);
  let closed = false;
  let tail: Promise<void> = Promise.resolve();
  const enqueue = (line: string): void => {
    tail = appendAfter(tail, path, line);
  };
  return {
    close: async () => {
      if (!closed) {
        closed = true;
        for (const line of policy.flush()) {
          enqueue(line);
        }
      }
      await tail;
    },
    write: (line) => {
      if (closed) {
        return;
      }
      for (const output of policy.accept(line)) {
        enqueue(output);
      }
    },
  };
};

export { makeCodexStderrLog, makeCodexStderrPolicy };
export type { CodexLogMode, CodexStderrLog, CodexStderrPolicy };
