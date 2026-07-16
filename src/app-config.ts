import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { Effect, Schema } from 'effect';

import { ChatGuid } from './domain/ids';
import { SpikeRuntimeError } from './errors';
import type { SpikePaths } from './paths';

const NonEmptyString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0, { title: 'non-empty string' }),
  ),
);

const CasingMode = Schema.Literals(['lowercase', 'natural']);
type CasingMode = typeof CasingMode.Type;

const EmojiMode = Schema.Literals(['off', 'on', 'after_user']);
type EmojiMode = typeof EmojiMode.Type;

const FinalPunctuationMode = Schema.Literals(['no_full_stop', 'natural']);
type FinalPunctuationMode = typeof FinalPunctuationMode.Type;

const SwearingMode = Schema.Literals(['off', 'tasteful', 'mirror', 'filthy']);
type SwearingMode = typeof SwearingMode.Type;

const WitMode = Schema.Literals(['off', 'dry', 'playful']);
type WitMode = typeof WitMode.Type;

const SpikeConfigFile = Schema.Struct({
  casing: Schema.optionalKey(CasingMode),
  chat_guid: NonEmptyString,
  codex_executable: Schema.optionalKey(NonEmptyString),
  codex_home: Schema.optionalKey(NonEmptyString),
  emoji: Schema.optionalKey(EmojiMode),
  final_punctuation: Schema.optionalKey(FinalPunctuationMode),
  handle: NonEmptyString,
  like_acknowledgements: Schema.optionalKey(Schema.Boolean),
  messages_database: Schema.optionalKey(NonEmptyString),
  prompt_path: Schema.optionalKey(NonEmptyString),
  swearing: Schema.optionalKey(SwearingMode),
  wit: Schema.optionalKey(WitMode),
  working_directory: NonEmptyString,
});

interface SpikeConfig {
  readonly casing: CasingMode;
  readonly chatGuid: ChatGuid;
  readonly codexExecutable: string;
  readonly codexHome: string;
  readonly emoji: EmojiMode;
  readonly finalPunctuation: FinalPunctuationMode;
  readonly handle: string;
  readonly likeAcknowledgements: boolean;
  readonly messagesDatabase: string;
  readonly promptPath: string;
  readonly swearing: SwearingMode;
  readonly wit: WitMode;
  readonly workingDirectory: string;
}

const expandPath = (value: string): string =>
  value === '~' || value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;

const loadSpikeConfig = (paths: SpikePaths): Effect.Effect<SpikeConfig, SpikeRuntimeError> =>
  Effect.gen(function* loadConfig() {
    const parsed = yield* Effect.tryPromise({
      catch: (cause) =>
        new SpikeRuntimeError({
          cause,
          message: `failed to read ${paths.config}: ${cause instanceof Error ? cause.message : String(cause)}`,
          operation: 'load-config',
        }),
      try: async () => Bun.TOML.parse(await readFile(paths.config, 'utf8')),
    });
    const decoded = yield* Schema.decodeUnknownEffect(SpikeConfigFile)(parsed).pipe(
      Effect.mapError(
        (cause) =>
          new SpikeRuntimeError({
            cause,
            message: `invalid ${paths.config}: ${String(cause)}`,
            operation: 'load-config',
          }),
      ),
    );
    return {
      casing: decoded.casing ?? 'lowercase',
      chatGuid: ChatGuid.make(decoded.chat_guid),
      codexExecutable: decoded.codex_executable ?? 'codex',
      codexHome: expandPath(decoded.codex_home ?? paths.codexHome),
      emoji: decoded.emoji ?? 'after_user',
      finalPunctuation: decoded.final_punctuation ?? 'no_full_stop',
      handle: decoded.handle,
      likeAcknowledgements: decoded.like_acknowledgements ?? true,
      messagesDatabase: expandPath(
        decoded.messages_database ?? path.join(homedir(), 'Library', 'Messages', 'chat.db'),
      ),
      promptPath: expandPath(decoded.prompt_path ?? paths.prompt),
      swearing: decoded.swearing ?? 'tasteful',
      wit: decoded.wit ?? 'dry',
      workingDirectory: expandPath(decoded.working_directory),
    };
  });

export { loadSpikeConfig };
export type { CasingMode, EmojiMode, FinalPunctuationMode, SpikeConfig, SwearingMode, WitMode };
