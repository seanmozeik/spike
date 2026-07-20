import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  CodexModelOption,
  CodexSetup,
  OnboardingPlan,
  ReasoningOption,
  ServiceTierOption,
} from './types';

const stringValue = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const reasoningOptions = (value: unknown): readonly ReasoningOption[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) {
          return [];
        }
        const effort = stringValue(Reflect.get(entry, 'effort'));
        return effort === ''
          ? []
          : [{ description: stringValue(Reflect.get(entry, 'description')), effort }];
      })
    : [];

const serviceTierOptions = (model: object): readonly ServiceTierOption[] => {
  const speedTiers: unknown = Reflect.get(model, 'additional_speed_tiers');
  return Array.isArray(speedTiers)
    ? speedTiers
        .filter((value): value is string => typeof value === 'string')
        .map((id) => ({ description: 'Faster responses with increased usage', id, name: id }))
    : [];
};

const parseModelCatalog = (value: unknown): readonly CodexModelOption[] => {
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  const models: unknown = Reflect.get(value, 'models');
  if (!Array.isArray(models)) {
    return [];
  }
  return models
    .filter((entry): entry is object => typeof entry === 'object' && entry !== null)
    .flatMap((entry) => {
      const slug = stringValue(Reflect.get(entry, 'slug'));
      if (slug === '' || Reflect.get(entry, 'visibility') === 'hidden') {
        return [];
      }
      const defaultReasoning = stringValue(Reflect.get(entry, 'default_reasoning_level'), 'medium');
      const discoveredReasoning = reasoningOptions(
        Reflect.get(entry, 'supported_reasoning_levels'),
      );
      const reasoning =
        discoveredReasoning.length === 0
          ? [{ description: 'Model default', effort: defaultReasoning }]
          : discoveredReasoning;
      return [
        {
          defaultReasoning,
          description: stringValue(Reflect.get(entry, 'description')),
          displayName: stringValue(Reflect.get(entry, 'display_name'), slug),
          reasoning,
          serviceTiers: serviceTierOptions(entry),
          slug,
        },
      ];
    });
};

const discoverCodexModels = (codexExecutable: string): readonly CodexModelOption[] => {
  const result = Bun.spawnSync([codexExecutable, 'debug', 'models'], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`Codex model discovery failed: ${result.stderr.toString().trim()}`);
  }
  const models = parseModelCatalog(JSON.parse(result.stdout.toString()));
  if (models.length === 0) {
    throw new Error('Codex returned an empty model catalog');
  }
  return models;
};

const validateCodexConfiguration = (codexExecutable: string, codexHome: string): void => {
  const result = Bun.spawnSync([codexExecutable, 'debug', 'models', '--bundled'], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stderr: 'pipe',
    stdout: 'ignore',
  });
  if (result.exitCode !== 0) {
    throw new Error(`Codex rejected its configuration: ${result.stderr.toString().trim()}`);
  }
};

const tomlString = (value: string): string => JSON.stringify(value);

const PRIVACY_CONFIG = [
  '[analytics]',
  'enabled = false',
  '',
  '[feedback]',
  'enabled = false',
  '',
  '[history]',
  'persistence = "none"',
  '',
  '[otel]',
  'exporter = "none"',
  'metrics_exporter = "none"',
  'trace_exporter = "none"',
  'log_user_prompt = false',
].join('\n');

const applyPolicy = (config: string, policy: string): string => {
  let insideTable = false;
  const preserved = config.split('\n').filter((line) => {
    if (/^\s*\[/u.test(line)) {
      insideTable = true;
    }
    return insideTable || !/^\s*(?:approval_policy|sandbox_mode)\s*=/u.test(line);
  });
  return `${policy}\n${preserved.join('\n').trim()}\n`;
};

const renderCodexConfig = async (
  setup: CodexSetup,
  approvalPolicy: OnboardingPlan['approvalPolicy'],
  sandboxMode: 'danger-full-access' | 'read-only' | 'workspace-write',
): Promise<string> => {
  const policy = `approval_policy = ${tomlString(approvalPolicy)}\nsandbox_mode = ${tomlString(sandboxMode)}`;
  if (setup.kind === 'custom') {
    return applyPolicy(await readFile(setup.configPath, 'utf8'), policy);
  }
  if (setup.kind === 'skip') {
    return `${policy}\n${PRIVACY_CONFIG}\n`;
  }
  const lines = [
    `model = ${tomlString(setup.model)}`,
    `model_reasoning_effort = ${tomlString(setup.reasoning)}`,
    `personality = ${tomlString(setup.personality)}`,
    setup.serviceTier === null ? null : `service_tier = ${tomlString(setup.serviceTier)}`,
    policy,
  ];
  return `${lines.filter((line): line is string => line !== null).join('\n')}\n${PRIVACY_CONFIG}\n`;
};

const authenticateCodex = async (
  codexExecutable: string,
  codexHome: string,
  onOutput: (message: string) => void,
): Promise<void> => {
  await mkdir(codexHome, { recursive: true });
  const authPath = path.join(codexHome, 'auth.json');
  if (await Bun.file(authPath).exists()) {
    return;
  }
  onOutput('Starting isolated Codex device authentication');
  const child = Bun.spawn([codexExecutable, 'login', '--device-auth'], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stderr: 'inherit',
    stdin: 'inherit',
    stdout: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0 || !(await Bun.file(authPath).exists())) {
    throw new Error('Codex authentication did not create auth.json in Spike’s isolated home');
  }
};

const seedDefaultAccount = async (codexHome: string, accountsDirectory: string): Promise<void> => {
  const source = path.join(codexHome, 'auth.json');
  if (!(await Bun.file(source).exists())) {
    return;
  }
  const destination = path.join(accountsDirectory, 'default');
  await mkdir(destination, { recursive: true });
  await copyFile(source, path.join(destination, 'auth.json'));
};

export {
  authenticateCodex,
  discoverCodexModels,
  parseModelCatalog,
  renderCodexConfig,
  seedDefaultAccount,
  validateCodexConfiguration,
};
