import * as clack from '@clack/prompts';

const unwrap = <A>(value: A | symbol): A => {
  if (clack.isCancel(value)) {
    clack.cancel('Onboarding cancelled. Nothing was changed.');
    throw new Error('onboarding cancelled');
  }
  return value;
};

const cancelGroup = (): void => {
  clack.cancel('Onboarding cancelled. Nothing was changed.');
  throw new Error('onboarding cancelled');
};

export { cancelGroup, unwrap };
