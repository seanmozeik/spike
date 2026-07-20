import { appendFile } from 'node:fs/promises';

import { plainLogText } from '../logging/plain-text';

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
const MAX_REPETITION_GROUPS = 32;
const RUST_LOG_LINE =
  /^\S+\s+(?<level>TRACE|DEBUG|INFO|WARN|ERROR)\s+(?<module>\S+):\s+(?<message>.*)$/u;
const STATE_TRANSITION =
  /\b(?:exited|initialized|restarted|shutting down|started|starting|stopped|stopping)\b/iu;

const isLogLevel = (value: string | undefined): value is ParsedRustLogLine['level'] =>
  value === 'TRACE' ||
  value === 'DEBUG' ||
  value === 'INFO' ||
  value === 'WARN' ||
  value === 'ERROR';

const parseRustLogLine = (line: string): ParsedRustLogLine | null => {
  const groups = RUST_LOG_LINE.exec(line)?.groups;
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

const evictOldestRepetition = (groups: Map<string, RepetitionGroup>): readonly string[] => {
  const oldestKey = groups.keys().next().value;
  if (oldestKey === undefined) {
    return [];
  }
  const oldest = groups.get(oldestKey);
  groups.delete(oldestKey);
  return oldest === undefined || oldest.count === 0
    ? []
    : [repeatSummary(oldest.flow, oldest.count)];
};

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

const recordRepetition = (
  groups: Map<string, RepetitionGroup>,
  flow: RepetitiveCodexFlow,
  message: string,
  firstLine: string,
): readonly string[] => {
  const key = repetitionKey(flow, message);
  const group = groups.get(key);
  if (group === undefined) {
    const summaries = groups.size >= MAX_REPETITION_GROUPS ? evictOldestRepetition(groups) : [];
    groups.set(key, { count: 0, flow });
    return [...summaries, firstLine];
  }
  const count = group.count + 1;
  groups.delete(key);
  groups.set(key, { count, flow });
  if (count < SUMMARY_INTERVAL) {
    return [];
  }
  groups.set(key, { count: 0, flow });
  return [repeatSummary(flow, count)];
};

const makeCodexStderrPolicy = (mode: CodexLogMode): CodexStderrPolicy => {
  if (mode === 'verbose') {
    return { accept: (line) => [plainLogText(line)], flush: () => [] };
  }

  const repetitions = new Map<string, RepetitionGroup>();
  return {
    accept: (line) => {
      const normalized = plainLogText(line);
      const parsed = parseRustLogLine(normalized);
      if (parsed === null) {
        return [normalized];
      }
      if (parsed.level === 'TRACE' || parsed.level === 'DEBUG') {
        return [];
      }
      const flow = repetitiveFlow(parsed);
      if (flow !== null) {
        return recordRepetition(repetitions, flow, parsed.message, normalized);
      }
      if (parsed.level === 'INFO' && !STATE_TRANSITION.test(parsed.message)) {
        return [];
      }
      return [normalized];
    },
    flush: () => flushSummaries(repetitions),
  };
};

const appendDiagnostic = async (path: string, line: string): Promise<void> => {
  try {
    await appendFile(path, `${plainLogText(line)}\n`, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[error] Spike could not persist Codex stderr: ${detail}\n${plainLogText(line)}\n`,
    );
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
