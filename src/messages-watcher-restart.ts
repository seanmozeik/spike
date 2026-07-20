import type { WatcherRestartOwner } from './messages-watcher-types';

const makeWatcherRestartOwner = (delayMs: number): WatcherRestartOwner => {
  let restart: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    close: (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    schedule: (): void => {
      if (timer !== null || restart === null) {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        restart?.();
      }, delayMs);
    },
    scheduled: (): boolean => timer !== null,
    setRestart: (next): void => {
      restart = next;
    },
  };
};

export { makeWatcherRestartOwner };
