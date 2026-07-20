type ControlCommand = '/new' | '/status';

const parseControlCommand = (text: null | string): ControlCommand | null => {
  const command = text?.trim().toLowerCase();
  return command === '/new' || command === '/status' ? command : null;
};

export { parseControlCommand };
export type { ControlCommand };
