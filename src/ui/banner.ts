import gradient from 'gradient-string';

const SPIKE_GREEN_PALETTE = ['#d8f078', '#92d050', '#4fa83d', '#226b3a'] as const;

const bannerGradient = gradient([...SPIKE_GREEN_PALETTE]);

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

const renderBanner = (color = colorIsEnabled()): string =>
  color ? bannerGradient.multiline(SPIKE_BANNER) : SPIKE_BANNER;

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
