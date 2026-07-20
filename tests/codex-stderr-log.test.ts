import { describe, expect, it } from 'vitest';

import { makeCodexStderrPolicy } from '../src/codex/stderr-log';

const logLine = (
  level: 'DEBUG' | 'ERROR' | 'INFO' | 'TRACE' | 'WARN',
  module: string,
  message: string,
): string => `2026-07-19T10:00:00.000000Z ${level} ${module}: ${message}`;

const coloredLogLine = (
  level: 'DEBUG' | 'ERROR' | 'INFO' | 'TRACE' | 'WARN',
  module: string,
  message: string,
): string =>
  `\u{1B}[2m2026-07-19T10:00:00.000000Z\u{1B}[0m \u{1B}[31m${level}\u{1B}[0m \u{1B}[2m${module}\u{1B}[0m\u{1B}[2m:\u{1B}[0m ${message}`;

const websocketFailure = logLine(
  'ERROR',
  'codex_api::endpoint::responses_websocket',
  'failed to connect to websocket: HTTP error: 403 Forbidden',
);

describe('Codex stderr policy', () => {
  it('keeps quiet operation free of diagnostics while retaining warnings and state changes', () => {
    const policy = makeCodexStderrPolicy('quiet');
    const debug =
      '\u{1B}[2m2026-07-19T10:00:00.000000Z\u{1B}[0m \u{1B}[34mDEBUG\u{1B}[0m \u{1B}[2mcodex_core::poll\u{1B}[0m\u{1B}[2m:\u{1B}[0m polling account state';
    const info = logLine('INFO', 'codex_core::poll', 'account remains available');
    const started = logLine('INFO', 'codex_core::runtime', 'runtime started');
    const warning = coloredLogLine('WARN', 'codex_core::runtime', 'runtime capacity is degraded');

    expect(policy.accept(debug)).toStrictEqual([]);
    expect(policy.accept(info)).toStrictEqual([]);
    expect(policy.accept(started)).toStrictEqual([started]);
    expect(policy.accept(warning)).toStrictEqual([
      logLine('WARN', 'codex_core::runtime', 'runtime capacity is degraded'),
    ]);
  });

  it('never promotes TRACE or DEBUG lines based on transition words', () => {
    const policy = makeCodexStderrPolicy('quiet');
    const debugStarted = logLine(
      'DEBUG',
      'codex_api::client',
      'request started authorization=sensitive-token',
    );
    const traceStopped = logLine('TRACE', 'codex_api::client', 'request stopped');

    expect(policy.accept(debugStarted)).toStrictEqual([]);
    expect(policy.accept(traceStopped)).toStrictEqual([]);
  });

  it('retains every diagnostic line in verbose mode', () => {
    const policy = makeCodexStderrPolicy('verbose');
    const diagnostic = coloredLogLine('DEBUG', 'codex_core::poll', 'polling account state');

    expect(policy.accept(diagnostic)).toStrictEqual([
      logLine('DEBUG', 'codex_core::poll', 'polling account state'),
    ]);
    expect(policy.accept(websocketFailure)).toStrictEqual([websocketFailure]);
    expect(policy.accept(websocketFailure)).toStrictEqual([websocketFailure]);
    expect(policy.flush()).toStrictEqual([]);
  });

  it('coalesces representative repetitive failures into stable summaries', () => {
    const policy = makeCodexStderrPolicy('quiet');
    const output = [...policy.accept(websocketFailure)];
    for (let index = 0; index < 28; index += 1) {
      output.push(...policy.accept(websocketFailure));
    }
    output.push(...policy.flush());

    expect(output).toStrictEqual([
      websocketFailure,
      '[warn] codex app-server repeats suppressed flow=responses-websocket-unavailable count=25',
      '[warn] codex app-server repeats suppressed flow=responses-websocket-unavailable count=3',
    ]);
  });

  it('tracks model-refresh timeout noise independently', () => {
    const policy = makeCodexStderrPolicy('quiet');
    const refreshFailure = logLine(
      'ERROR',
      'codex_models_manager::manager',
      'failed to refresh available models: timeout waiting for child process to exit',
    );

    expect(policy.accept(refreshFailure)).toStrictEqual([refreshFailure]);
    expect(policy.accept(refreshFailure)).toStrictEqual([]);
    expect(policy.flush()).toStrictEqual([
      '[warn] codex app-server repeats suppressed flow=model-refresh-timeout count=1',
    ]);
  });

  it('keeps the first occurrence of each distinct failure detail visible', () => {
    const policy = makeCodexStderrPolicy('quiet');
    const resetFailure = logLine(
      'ERROR',
      'codex_api::endpoint::responses_websocket',
      'failed to connect to websocket: connection reset by peer',
    );

    expect(policy.accept(websocketFailure)).toStrictEqual([websocketFailure]);
    expect(policy.accept(resetFailure)).toStrictEqual([resetFailure]);
    expect(policy.flush()).toStrictEqual([]);
  });

  it('bounds variable repetitive signatures and reports suppressed repeats before eviction', () => {
    const policy = makeCodexStderrPolicy('quiet');
    const output = [...policy.accept(websocketFailure)];
    expect(policy.accept(websocketFailure)).toStrictEqual([]);

    for (let index = 0; index < 40; index += 1) {
      const failure = logLine(
        'ERROR',
        'codex_api::endpoint::responses_websocket',
        `failed to connect to websocket: variable detail ${String(index)}`,
      );
      output.push(...policy.accept(failure));
    }

    expect(output).toContain(
      '[warn] codex app-server repeats suppressed flow=responses-websocket-unavailable count=1',
    );
    expect(policy.accept(websocketFailure)).toStrictEqual([websocketFailure]);
  });

  it('preserves actionable failure context while removing terminal presentation codes', () => {
    const policy = makeCodexStderrPolicy('quiet');
    const failure = logLine(
      'ERROR',
      'codex_core::tools::router',
      'hook failed correlation_id=corr-1 thread_id=thread-2 turn_id=turn-3 client_user_message_id=message-4',
    );

    expect(policy.accept(failure)).toStrictEqual([failure]);
    expect(
      policy.accept('\u{1B}[31mchild exited before emitting structured diagnostics\u{1B}[0m'),
    ).toStrictEqual(['child exited before emitting structured diagnostics']);
  });
});
