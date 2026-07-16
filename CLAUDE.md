# spike engineering contract

## Stack

- Bun 1.3 or newer
- TypeScript 7 in strict mode
- Effect v4 beta, with all Effect packages pinned to the same beta
- Vitest under Bun, with `@effect/vitest` for Effect programs
- oxlint and oxfmt with no blanket suppressions

Before changing Effect code, use the effect-v4 skill, `effect-solutions` and inspect the installed
Effect source. Use `Context.Service`, one explicit Layer assembly point, shared
schemas at boundaries, `Schema.TaggedErrorClass` for expected failures, and
`Effect.fn` spans on meaningful operations.

## Architecture

- The Bun daemon owns `chat.db` reads and the only writable `spike.db` connection.
- CLI mutations go through the control socket. Offline doctor access is read-only.
- launchd owns daemon lifecycle. Never build a second process supervisor into the CLI.
- Spike owns its CODEX_HOME, app-server child, account pool, state, socket, and logs.
- Other agent runtimes are references only. Never share their processes, sockets, or state.
- Input, model coordination, output filtering, iMessage delivery, and presence are
  separate adapters. A failure in one must not silently mutate another's state.
- Model reasoning, tool calls, and progress events never reach iMessage. Only the
  single optional work acknowledgement and final answer are deliverable.

## Gate

Run `just verify` for every ticket. It must perform formatting, strict lint,
typecheck, tests, and the production build. Add the ticket-specific smoke or
fault test, run the thermonuclear maintainability review, fix every structural
finding, then rerun the complete gate. Never make a gate pass by weakening
strictness, excluding production code, or adding blanket disables.

## Code reading

Use `sb digest` for an unfamiliar directory, `sb map` for a file's shape, and
`sb show` for one body. Use `sb search` when the symbol is unknown and
`sb reverse-deps` before moving a module. Run `sb cycles src` during structural
review. Prefer these over dumping whole files or broad text searches.

## Operational restraint

Tests and local smoke runs must use `SPIKE_HOME` under a temporary
directory. Do not load, stop, restart, or overwrite the real LaunchAgent during
unit or integration tests. Live TCC and self-chat tests belong to their explicit
cutover tickets.
