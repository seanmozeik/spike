import { Flag } from 'effect/unstable/cli';

const jsonFlag = Flag.boolean('json').pipe(Flag.withDescription('Print pretty JSON output'));
const agentFlag = Flag.boolean('agent').pipe(
  Flag.withDescription('Print compact single-line JSON for agents'),
);
export const outputMode = { agent: agentFlag, json: jsonFlag };
