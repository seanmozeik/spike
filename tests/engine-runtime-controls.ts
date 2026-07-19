import type { EngineFixture } from './engine-fixture-types';
import type { RuntimeTrace } from './fake-codex-runtime';

const makeEngineRuntimeControls = (
  trace: RuntimeTrace,
): Pick<EngineFixture, 'closeCodexConnection' | 'requestApproval' | 'resolveServerRequest'> => ({
  closeCodexConnection: (): void => {
    for (const listener of trace.closeListeners) {
      listener();
    }
  },
  requestApproval: (request): void => {
    for (const listener of trace.requestListeners) {
      listener(request);
    }
  },
  resolveServerRequest: (id): void => {
    for (const listener of trace.notificationListeners) {
      listener({ method: 'serverRequest/resolved', params: { requestId: id } });
    }
  },
});

export { makeEngineRuntimeControls };
