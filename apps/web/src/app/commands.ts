import { useState } from 'react';
import { ApiError } from '../lib/api-client.js';
import { useAlive } from './session.js';

/**
 * A page's commands (R-D4 increment 4b): one busy flag and one error slot. A command refreshes
 * the page's own keys when it succeeds (`refresh`); its result is dropped once the page is gone,
 * as after a change of workspace (CT03-R2R3).
 */
export function useCommands(refresh: () => void) {
  const alive = useAlive();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = (operation: () => Promise<unknown>, fallback = 'The request failed'): void => {
    setBusy(true);
    setError(undefined);
    void operation()
      .then(() => {
        if (alive()) refresh();
      })
      .catch((failure: unknown) => {
        if (alive()) setError(failure instanceof ApiError ? failure.message : fallback);
      })
      .finally(() => {
        if (alive()) setBusy(false);
      });
  };
  return { busy, error, setError, run };
}
