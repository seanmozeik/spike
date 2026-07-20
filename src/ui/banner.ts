const SPIKE_GREEN_GRADIENT = [
  '\u001B[38;2;216;240;120m',
  '\u001B[38;2;185;225;99m',
  '\u001B[38;2;146;208;80m',
  '\u001B[38;2;104;184;62m',
  '\u001B[38;2;70;145;57m',
  '\u001B[38;2;34;107;58m',
] as const;
const RESET_FOREGROUND = '\u001B[39m';

const SPIKE_BANNER = `
               .__ __
  ____________ |__|  | __ ____
 /  ___/\\____ \\|  |  |/ // __ \\
 \\___ \\ |  |_> >  |    <\\  ___/
/____  >|   __/|__|__|_ \\\\___  >
     \\/ |__|           \\/    \\/ `;

const colorIsEnabled = (): boolean =>
  process.env['NO_COLOR'] === undefined &&
  (process.stdout.isTTY ||
    (process.env['FORCE_COLOR'] !== undefined && process.env['FORCE_COLOR'] !== '0'));

const colorLine = (line: string, index: number): string => {
  const color = SPIKE_GREEN_GRADIENT[index] ?? SPIKE_GREEN_GRADIENT[0];
  return `${color}${line}${RESET_FOREGROUND}`;
};

const renderBanner = (color = colorIsEnabled()): string =>
  color
    ? SPIKE_BANNER.split('\n')
        .map((line, index) => (line.length === 0 ? line : colorLine(line, index - 1)))
        .join('\n')
    : SPIKE_BANNER;

const showBanner = (): void => {
  process.stdout.write(`${renderBanner()}\n`);
};

const shouldShowCliBanner = (arguments_: readonly string[]): boolean =>
  arguments_.length === 0 ||
  arguments_.some(
    (argument) =>
      argument === '--help' || argument === '-h' || argument === '--version' || argument === '-v',
  );

export { renderBanner, shouldShowCliBanner, showBanner, SPIKE_BANNER };
