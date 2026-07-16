import { readFile } from 'node:fs/promises';
import path from 'node:path';

interface HookDiagnostic {
  readonly detail: string;
  readonly name: 'hooks';
  readonly state: 'fail' | 'pass';
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const checkHooks = async (
  codexHome: string,
  codex: Record<string, unknown>,
): Promise<HookDiagnostic> => {
  const features = isObject(codex['features']) ? codex['features'] : {};
  if (features['hooks'] !== true && features['plugin_hooks'] !== true) {
    return { detail: 'none configured', name: 'hooks', state: 'pass' };
  }
  const hooksPath = path.join(codexHome, 'hooks.json');
  const available = await readFile(hooksPath, 'utf8').then(
    () => true,
    () => false,
  );
  return available
    ? { detail: 'configured hook file available', name: 'hooks', state: 'pass' }
    : { detail: 'hooks enabled but no hook file is available', name: 'hooks', state: 'fail' };
};

export { checkHooks };
export type { HookDiagnostic };
