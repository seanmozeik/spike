import * as clack from '@clack/prompts';

import { cancelGroup } from './prompt-shared';
import type { PersonalityAnswers } from './types';

const casingPrompt = (): ReturnType<typeof clack.select<'lowercase' | 'natural'>> =>
  clack.select({
    message: 'How should Spike use letter case?',
    options: [
      { label: 'Mostly lowercase', value: 'lowercase' as const },
      { label: 'Natural casing', value: 'natural' as const },
    ],
  });

const personalityPrompt = (): Promise<PersonalityAnswers> =>
  clack.group(
    {
      casing: casingPrompt,
      emoji: () =>
        clack.select({
          message: 'How should Spike use emoji?',
          options: [
            { label: 'Mirror me', value: 'after_user' as const },
            { label: 'Use them', value: 'on' as const },
            { label: 'Never', value: 'off' as const },
          ],
        }),
      finalPunctuation: () =>
        clack.select({
          message: 'How should Spike end short messages?',
          options: [
            { label: 'Skip the final full stop', value: 'no_full_stop' as const },
            { label: 'Use natural punctuation', value: 'natural' as const },
          ],
        }),
      likeAcknowledgements: () =>
        clack.confirm({ initialValue: true, message: 'May Spike Like messages while it works?' }),
      swearing: () =>
        clack.select({
          message: 'May Spike swear?',
          options: [
            { label: 'No', value: 'off' as const },
            { label: 'Tastefully', value: 'tasteful' as const },
            { label: 'Mirror me', value: 'mirror' as const },
            { label: 'Yes, freely', value: 'filthy' as const },
          ],
        }),
      wit: () =>
        clack.select({
          message: 'How witty should Spike be?',
          options: [
            { label: 'Straight', value: 'off' as const },
            { label: 'Dry', value: 'dry' as const },
            { label: 'Playful', value: 'playful' as const },
          ],
        }),
    },
    { onCancel: cancelGroup },
  );

export { personalityPrompt };
