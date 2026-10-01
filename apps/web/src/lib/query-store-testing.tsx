import type { WorkspaceEventEnvelope } from '@craftingtable/contracts';
import { act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { invalidationsFor } from './event-invalidations.js';
import { createQueryStore, QueryStoreProvider } from './query-store.js';

/**
 * A store for a component test (R-D4): `wrap` renders under it, and `send` delivers a workspace
 * event through the event table, as the app does, then lets the re-reads run.
 */
export function testQueryStore() {
  const store = createQueryStore({ debounceMs: 0, maxWaitMs: 0 });
  return {
    store,
    wrap: (ui: ReactNode) => <QueryStoreProvider value={store}>{ui}</QueryStoreProvider>,
    send: async (kind: string, fields: Record<string, unknown>) => {
      await act(async () => {
        store.invalidate(
          invalidationsFor({ kind, payload: {}, ...fields } as unknown as WorkspaceEventEnvelope),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    },
  };
}
