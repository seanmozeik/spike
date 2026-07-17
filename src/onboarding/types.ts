type CasingMode = 'lowercase' | 'natural';
type EmojiMode = 'after_user' | 'off' | 'on';
type FinalPunctuationMode = 'natural' | 'no_full_stop';
type SwearingMode = 'filthy' | 'mirror' | 'off' | 'tasteful';
type WitMode = 'dry' | 'off' | 'playful';

interface ConversationCandidate {
  readonly chatGuid: string;
  readonly handle: string;
  readonly lastMessageAt: Date | null;
}

interface PersonalityAnswers {
  readonly casing: CasingMode;
  readonly emoji: EmojiMode;
  readonly finalPunctuation: FinalPunctuationMode;
  readonly likeAcknowledgements: boolean;
  readonly swearing: SwearingMode;
  readonly wit: WitMode;
}

interface ReasoningOption {
  readonly description: string;
  readonly effort: string;
}

interface ServiceTierOption {
  readonly description: string;
  readonly id: string;
  readonly name: string;
}

interface CodexModelOption {
  readonly defaultReasoning: string;
  readonly description: string;
  readonly displayName: string;
  readonly reasoning: readonly ReasoningOption[];
  readonly serviceTiers: readonly ServiceTierOption[];
  readonly slug: string;
}

type CodexSetup =
  | {
      readonly kind: 'openai';
      readonly model: string;
      readonly personality: 'friendly' | 'pragmatic' | 'none';
      readonly reasoning: string;
      readonly serviceTier: string | null;
    }
  | { readonly configPath: string; readonly kind: 'custom' }
  | { readonly kind: 'skip' };

interface OnboardingPlan {
  readonly approvalPolicy: 'never' | 'on-request';
  readonly codex: CodexSetup;
  readonly context: string;
  readonly conversation: ConversationCandidate;
  readonly messagesDatabase: string;
  readonly personality: PersonalityAnswers;
  readonly sandboxMode: 'danger-full-access' | 'read-only' | 'workspace-write';
  readonly workingDirectory: string;
}

export type {
  CasingMode,
  CodexModelOption,
  CodexSetup,
  ConversationCandidate,
  EmojiMode,
  FinalPunctuationMode,
  OnboardingPlan,
  PersonalityAnswers,
  ReasoningOption,
  ServiceTierOption,
  SwearingMode,
  WitMode,
};
