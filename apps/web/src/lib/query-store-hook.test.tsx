import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createQueryStore, QueryStoreProvider, useQuery } from './query-store.js';

afterEach(cleanup);

function Reader({ loader }: { loader: () => Promise<string> }) {
  const query = useQuery(['k'], loader);
  return <p>{query.data ?? 'loading'}</p>;
}

it("reads with the component's latest loader, not the one it first rendered with (R-D4 review M9)", async () => {
  const store = createQueryStore({ debounceMs: 0, maxWaitMs: 0 });
  const first = vi.fn(async () => 'first');
  const latest = vi.fn(async () => 'latest');
  const { rerender } = render(
    <QueryStoreProvider value={store}>
      <Reader loader={first} />
    </QueryStoreProvider>,
  );
  expect(await screen.findByText('first')).toBeTruthy();
  rerender(
    <QueryStoreProvider value={store}>
      <Reader loader={latest} />
    </QueryStoreProvider>,
  );
  await act(async () => {
    await store.refetch(['k']);
  });
  expect(latest).toHaveBeenCalledTimes(1);
  expect(first).toHaveBeenCalledTimes(1);
  expect(screen.getByText('latest')).toBeTruthy();
});
