import pkg from '../package.json' with { type: 'json' };

const spikeVersion = pkg.version;

export { spikeVersion };
