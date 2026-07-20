import path from 'node:path';

import { expect, it } from 'vitest';

import { isolatedEnvironment } from '../scripts/package-validation-environment';

const restoreEnvironment = (key: string, value: string | undefined): void => {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
};

it('constructs the exact packaged-command environment with a fixed locale', () => {
  const validationRoot = '/private/validation';
  const spikeHome = '/private/validation/spike';
  const userHome = '/private/validation/user';
  const fakeBin = '/private/validation/bin';
  const parentKey = 'SPIKE_VALIDATION_PARENT_SENTINEL';
  const previousParent = process.env[parentKey];
  const previousLang = process.env['LANG'];
  const previousLocale = process.env['LC_ALL'];
  process.env[parentKey] = 'must-not-leak';
  process.env['LANG'] = 'parent-locale';
  process.env['LC_ALL'] = 'parent-locale';
  try {
    const executablePath = [
      fakeBin,
      path.dirname(process.execPath),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ]
      .filter((entry, index, entries) => entries.indexOf(entry) === index)
      .join(':');
    expect(isolatedEnvironment(validationRoot, spikeHome, userHome, fakeBin)).toEqual({
      BUN_INSTALL_CACHE_DIR: '/private/validation/cache/bun',
      CODEX_HOME: '/private/validation/spike/codex-home',
      HOME: userHome,
      LANG: 'C',
      LC_ALL: 'C',
      LOGNAME: 'spike-validation',
      NO_COLOR: '1',
      PATH: executablePath,
      SHELL: '/bin/sh',
      SPIKE_HOME: spikeHome,
      TEMP: '/private/validation/tmp',
      TERM: 'xterm-256color',
      TMP: '/private/validation/tmp',
      TMPDIR: '/private/validation/tmp',
      USER: 'spike-validation',
      XDG_CACHE_HOME: '/private/validation/cache/xdg',
      XDG_CONFIG_HOME: '/private/validation/config/xdg',
      XDG_DATA_HOME: '/private/validation/data/xdg',
      XDG_STATE_HOME: '/private/validation/state/xdg',
    });
  } finally {
    restoreEnvironment(parentKey, previousParent);
    restoreEnvironment('LANG', previousLang);
    restoreEnvironment('LC_ALL', previousLocale);
  }
});
