import { type OutputMode, writeStructured } from './output';

export const toMode = (agent: boolean, json: boolean): OutputMode => {
  if (agent) {
    return 'agent';
  }
  return json ? 'json' : 'human';
};

export const emit = (mode: OutputMode, value: unknown, human: () => void): void => {
  if (mode === 'human') {
    human();
  } else {
    writeStructured(mode, value);
  }
};
