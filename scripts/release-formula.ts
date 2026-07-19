interface FormulaIdentity {
  readonly sha256: string;
  readonly version: string;
}

const replaceExactlyOnce = (
  source: string,
  pattern: RegExp,
  replacement: string,
  label: string,
): string => {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${label} in Formula/spike.rb; found ${matches.length}`);
  }
  return source.replace(pattern, replacement);
};

const updateFormula = (source: string, identity: FormulaIdentity): string => {
  let updated = replaceExactlyOnce(
    source,
    /^(?<prefix>\s*url\s+"https:\/\/github\.com\/seanmozeik\/spike\/releases\/download\/v)[^"]+(?<suffix>\/spike-)[^"]+(?<extension>\.tar\.gz")/mu,
    `$<prefix>${identity.version}$<suffix>${identity.version}$<extension>`,
    'release URL',
  );
  updated = replaceExactlyOnce(
    updated,
    /^(?<prefix>\s*version\s+")[^"]+(?<suffix>")/mu,
    `$<prefix>${identity.version}$<suffix>`,
    'version',
  );
  updated = replaceExactlyOnce(
    updated,
    /^(?<prefix>\s*sha256\s+")[0-9a-fA-F]+(?<suffix>")/mu,
    `$<prefix>${identity.sha256}$<suffix>`,
    'SHA256',
  );
  for (const expected of [
    `url "https://github.com/seanmozeik/spike/releases/download/v${identity.version}/spike-${identity.version}.tar.gz"`,
    `version "${identity.version}"`,
    `sha256 "${identity.sha256}"`,
  ]) {
    if (!updated.includes(expected)) {
      throw new Error(`Formula/spike.rb did not converge to ${expected}`);
    }
  }
  return updated;
};

export { updateFormula };
